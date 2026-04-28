-- SQL script to create necessary RPC functions in Supabase for atomic operations.
-- Run this in the Supabase SQL Editor.

--------------------------------------------------------------------------------
-- 1. update_balance_atomic
--------------------------------------------------------------------------------
-- Handles atomic updates for rub and stars balances.
-- Returns the new balances and success status.

CREATE OR REPLACE FUNCTION update_balance_atomic(
    p_user_id BIGINT,
    p_amount_rub NUMERIC DEFAULT 0,
    p_amount_stars NUMERIC DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_new_rub NUMERIC;
    v_new_stars NUMERIC;
BEGIN
    -- Ensure row exists
    INSERT INTO balances (user_id, rub_balance, stars_balance, xp, level)
    VALUES (p_user_id, 0, 0, 0, 1)
    ON CONFLICT (user_id) DO NOTHING;

    -- Update balances
    UPDATE balances
    SET 
        rub_balance = GREATEST(0, rub_balance + p_amount_rub),
        stars_balance = GREATEST(0, stars_balance + p_amount_stars),
        updated_at = NOW()
    WHERE user_id = p_user_id
    RETURNING rub_balance, stars_balance INTO v_new_rub, v_new_stars;

    -- Basic safety check
    IF v_new_rub IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'User not found or update failed');
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'rub_balance', v_new_rub,
        'stars_balance', v_new_stars
    );
END;
$$;

--------------------------------------------------------------------------------
-- 2. submit_task_atomic
--------------------------------------------------------------------------------
-- Atomically handles task completion:
-- - Checks if task is active and has slots left
-- - Decrements qty_left
-- - Closes task if qty_left becomes 0
-- - Records the completion in completions table
-- - Optionally handles auto-payment (reward + xp) if requested

CREATE OR REPLACE FUNCTION submit_task_atomic(
    p_user_id BIGINT,
    p_task_id UUID,
    p_proof_text TEXT DEFAULT NULL,
    p_proof_url TEXT DEFAULT NULL,
    p_status TEXT DEFAULT 'pending', -- 'pending' for manual, 'paid' for auto
    p_reward_rub NUMERIC DEFAULT 0,
    p_xp_added INT DEFAULT 0,
    p_ai_score INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_qty_left INT;
    v_task_status TEXT;
    v_new_rub NUMERIC;
    v_new_stars NUMERIC;
BEGIN
    -- 1. Check task status and qty_left with row locking
    SELECT qty_left, status INTO v_qty_left, v_task_status
    FROM tasks
    WHERE id = p_task_id
    FOR UPDATE;

    IF v_task_status IS NULL OR v_task_status != 'active' OR v_qty_left <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Task closed or not found');
    END IF;

    -- 2. Update task slots
    v_qty_left := v_qty_left - 1;
    UPDATE tasks
    SET 
        qty_left = v_qty_left,
        status = CASE WHEN v_qty_left <= 0 THEN 'closed' ELSE 'active' END
    WHERE id = p_task_id;

    -- 3. Record completion
    INSERT INTO completions (
        task_id, 
        user_id, 
        status, 
        proof_text, 
        proof_url, 
        ai_score, 
        moderated_at
    )
    VALUES (
        p_task_id, 
        p_user_id, 
        p_status, 
        p_proof_text, 
        p_proof_url, 
        p_ai_score,
        CASE WHEN p_status = 'paid' THEN NOW() ELSE NULL END
    );

    -- 4. If auto-paid, update balance and XP
    IF p_status = 'paid' THEN
        -- Ensure row exists in balances
        INSERT INTO balances (user_id, rub_balance, stars_balance, xp, level)
        VALUES (p_user_id, 0, 0, 0, 1)
        ON CONFLICT (user_id) DO NOTHING;

        UPDATE balances
        SET 
            rub_balance = rub_balance + p_reward_rub,
            xp = xp + p_xp_added,
            updated_at = NOW()
        WHERE user_id = p_user_id
        RETURNING rub_balance, stars_balance INTO v_new_rub, v_new_stars;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'status', p_status,
        'qty_left', v_qty_left,
        'new_rub', v_new_rub,
        'new_stars', v_new_stars
    );
END;
$$;

--------------------------------------------------------------------------------
-- 3. approve_proof_atomic
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION approve_proof_atomic(
    p_admin_id BIGINT,
    p_proof_id UUID,
    p_reward_rub NUMERIC,
    p_xp_added INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_task_id UUID;
    v_user_id BIGINT;
    v_qty_left INT;
BEGIN
    -- 1. Lock and check proof status
    SELECT task_id, user_id INTO v_task_id, v_user_id
    FROM completions
    WHERE id = p_proof_id AND status = 'pending'
    FOR UPDATE;

    IF v_task_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Proof already moderated or not found');
    END IF;

    -- 2. Lock and update task slots
    SELECT qty_left INTO v_qty_left
    FROM tasks
    WHERE id = v_task_id
    FOR UPDATE;

    v_qty_left := GREATEST(0, v_qty_left - 1);
    UPDATE tasks
    SET 
        qty_left = v_qty_left,
        status = CASE WHEN v_qty_left <= 0 THEN 'closed' ELSE 'active' END
    WHERE id = v_task_id;

    -- 3. Update completion
    UPDATE completions
    SET 
        status = 'paid',
        moderated_by = p_admin_id,
        moderated_at = NOW()
    WHERE id = p_proof_id;

    -- 4. Update balance and XP
    INSERT INTO balances (user_id, rub_balance, stars_balance, xp, level)
    VALUES (v_user_id, 0, 0, 0, 1)
    ON CONFLICT (user_id) DO NOTHING;

    UPDATE balances
    SET 
        rub_balance = rub_balance + p_reward_rub,
        xp = xp + p_xp_added,
        updated_at = NOW()
    WHERE user_id = v_user_id;

    RETURN jsonb_build_object('ok', true, 'qty_left', v_qty_left);
END;
$$;
