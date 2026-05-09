-- MIGRATIONS.SQL
-- Run these commands in your Supabase SQL Editor

-- 1. Create UNIQUE INDEX for payments to ensure idempotency
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_ref ON payments (provider, provider_ref);

-- 2. Create UNIQUE INDEX for withdrawals if not exists
CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_user_idempotency ON withdrawals (user_id, amount_rub, details, created_at);

-- 3. Create Audit Log table for balance changes
CREATE TABLE IF NOT EXISTS balance_audit_log (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    amount_change NUMERIC(20, 2) NOT NULL,
    new_balance NUMERIC(20, 2) NOT NULL,
    action_type TEXT NOT NULL, -- 'deposit', 'withdraw', 'bonus', 'referral', 'admin'
    reference_id TEXT, -- payment_id, withdrawal_id, etc.
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Create Atomic Withdrawal RPC function
CREATE OR REPLACE FUNCTION withdraw_rub_atomic(
    p_user_id BIGINT,
    p_amount NUMERIC(20, 2),
    p_details TEXT,
    p_username TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_current_balance NUMERIC(20, 2);
    v_new_balance NUMERIC(20, 2);
    v_withdrawal_id BIGINT;
BEGIN
    -- 1. Check current balance
    SELECT rub_balance INTO v_current_balance FROM balances WHERE user_id = p_user_id FOR UPDATE;
    
    IF v_current_balance IS NULL OR v_current_balance < p_amount THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Insufficient balance');
    END IF;

    -- 2. Deduct balance
    v_new_balance := v_current_balance - p_amount;
    UPDATE balances 
    SET rub_balance = v_new_balance, updated_at = NOW() 
    WHERE user_id = p_user_id AND rub_balance >= p_amount;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Balance changed during transaction or insufficient funds');
    END IF;

    -- 3. Create withdrawal record
    INSERT INTO withdrawals (user_id, tg_user_id, username, amount_rub, details, status, created_at)
    VALUES (p_user_id, p_user_id, p_username, p_amount, p_details, 'awaiting_review', NOW())
    RETURNING id INTO v_withdrawal_id;

    -- 4. Audit Log
    INSERT INTO balance_audit_log (user_id, amount_change, new_balance, action_type, reference_id)
    VALUES (p_user_id, -p_amount, v_new_balance, 'withdraw', v_withdrawal_id::text);

    RETURN jsonb_build_object('ok', true, 'withdrawal_id', v_withdrawal_id, 'new_balance', v_new_balance);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- 5. Create helper for deposit audit log
CREATE OR REPLACE FUNCTION log_balance_change_audit()
RETURNS TRIGGER AS $$
BEGIN
    -- This can be attached as a trigger to balances if needed, 
    -- but manual insertion from app code is more precise for 'action_type'.
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- 6. Create Atomic Balance Update RPC function (for task rewards/bonuses)
CREATE OR REPLACE FUNCTION update_balance_atomic(
    p_user_id BIGINT,
    p_amount NUMERIC(20, 2),
    p_action_type TEXT,
    p_reference_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_old_balance NUMERIC(20, 2);
    v_new_balance NUMERIC(20, 2);
BEGIN
    -- 1. Get current balance and lock
    SELECT rub_balance INTO v_old_balance FROM balances WHERE user_id = p_user_id FOR UPDATE;
    
    IF v_old_balance IS NULL THEN
        -- Create record if not exists (upsert behavior)
        INSERT INTO balances (user_id, rub_balance, updated_at)
        VALUES (p_user_id, p_amount, NOW())
        RETURNING rub_balance INTO v_new_balance;
    ELSE
        -- 2. Update balance with safety check for negative results
        IF v_old_balance + p_amount < 0 THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Resulting balance cannot be negative');
        END IF;
        
        UPDATE balances 
        SET rub_balance = rub_balance + p_amount, updated_at = NOW() 
        WHERE user_id = p_user_id AND (rub_balance + p_amount) >= 0
        RETURNING rub_balance INTO v_new_balance;
        
        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Update failed (race condition or insufficient funds)');
        END IF;
    END IF;

    -- 3. Audit Log
    INSERT INTO balance_audit_log (user_id, amount_change, new_balance, action_type, reference_id)
    VALUES (p_user_id, p_amount, v_new_balance, p_action_type, p_reference_id);

    RETURN jsonb_build_object('ok', true, 'new_balance', v_new_balance);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- 7. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_user_devices_hash ON user_devices (device_hash);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals (status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON balance_audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_completions_user_task ON task_completions (user_id, task_id);
CREATE INDEX IF NOT EXISTS idx_completions_status ON task_completions (status);

-- 9. submit_task_atomic (Hardened)
CREATE OR REPLACE FUNCTION submit_task_atomic(
    p_user_id BIGINT,
    p_task_id UUID,
    p_status TEXT,
    p_proof_text TEXT,
    p_proof_url TEXT,
    p_reward_rub NUMERIC DEFAULT 0,
    p_xp_added INTEGER DEFAULT 0,
    p_ai_score INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER AS $$
DECLARE
    v_qty_left INTEGER;
    v_task_status TEXT;
    v_already_exists BOOLEAN;
BEGIN
    -- 1. Check if user already submitted this task (and it's not rejected/failed)
    SELECT EXISTS (
        SELECT 1 FROM completions 
        WHERE task_id = p_task_id AND user_id = p_user_id 
        AND status NOT IN ('rejected', 'fake', 'cancelled', 'failed')
    ) INTO v_already_exists;

    IF v_already_exists THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Вы уже отправили отчет по этому заданию');
    END IF;

    -- 2. Check task availability
    SELECT qty_left, status INTO v_qty_left, v_task_status
    FROM tasks 
    WHERE id = p_task_id 
    FOR UPDATE;

    IF v_task_status IS NULL OR v_task_status != 'active' OR v_qty_left <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Места закончились или задание закрыто');
    END IF;

    -- 3. Reserve slot
    UPDATE tasks 
    SET qty_left = qty_left - 1,
        pending_count = CASE WHEN p_status != 'paid' THEN pending_count + 1 ELSE pending_count END,
        updated_at = NOW()
    WHERE id = p_task_id;

    -- 4. Create completion
    INSERT INTO completions (task_id, user_id, status, proof_text, proof_url, reward_rub, xp_added, ai_score, created_at)
    VALUES (p_task_id, p_user_id, p_status, p_proof_text, p_proof_url, p_reward_rub, p_xp_added, p_ai_score, NOW());

    -- 5. If status is paid, credit balance and log audit
    IF p_status = 'paid' AND p_reward_rub > 0 THEN
        PERFORM update_balance_atomic(p_user_id, p_reward_rub, 'task_reward', p_task_id::TEXT);
    END IF;

    RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- 10. pay_referral_bonus_atomic
CREATE OR REPLACE FUNCTION pay_referral_bonus_atomic(
    p_referred_id BIGINT,
    p_referrer_id BIGINT,
    p_bonus_rub NUMERIC,
    p_xp_added INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER AS $$
DECLARE
    v_status TEXT;
BEGIN
    -- 1. Lock and check status
    SELECT status INTO v_status FROM referrals 
    WHERE referred_id = p_referred_id AND referrer_id = p_referrer_id 
    FOR UPDATE;

    IF v_status IS NULL OR v_status != 'pending' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Referral already processed or not found');
    END IF;

    -- 2. Pay bonus
    PERFORM update_balance_atomic(p_referrer_id, p_bonus_rub, 'referral', p_referred_id::TEXT);
    IF p_xp_added > 0 THEN
        -- Assuming update_balance_atomic handles rub, we might need a separate xp update or modify it
        UPDATE balances SET xp = xp + p_xp_added WHERE user_id = p_referrer_id;
    END IF;

    -- 3. Update status
    UPDATE referrals 
    SET status = 'paid', paid_at = NOW() 
    WHERE referred_id = p_referred_id AND referrer_id = p_referrer_id;

    RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- 11. stats_add_atomic
CREATE OR REPLACE FUNCTION stats_add_atomic(
    p_day DATE,
    p_field TEXT,
    p_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER AS $$
BEGIN
    EXECUTE format('
        INSERT INTO stats (day, %I) 
        VALUES ($1, $2) 
        ON CONFLICT (day) DO UPDATE SET %I = stats.%I + $2', p_field, p_field, p_field)
    USING p_day, p_amount;
END;
$$;
