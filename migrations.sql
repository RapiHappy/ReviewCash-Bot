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

-- 8. Final Safety Constraints
ALTER TABLE balances ADD CONSTRAINT check_rub_non_negative CHECK (rub_balance >= 0);
ALTER TABLE balances ADD CONSTRAINT check_stars_non_negative CHECK (stars_balance >= 0);
