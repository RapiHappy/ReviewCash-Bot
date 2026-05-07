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
    UPDATE balances SET rub_balance = v_new_balance, updated_at = NOW() WHERE user_id = p_user_id;

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
