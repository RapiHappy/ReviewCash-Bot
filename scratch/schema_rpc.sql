-- SQL script to create hardened RPC functions in Supabase for atomic operations.
-- Run this in the Supabase SQL Editor.

--------------------------------------------------------------------------------
-- 1. update_balance_atomic
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_balance_atomic(
    p_user_id bigint,
    p_amount_rub numeric DEFAULT 0,
    p_amount_stars numeric DEFAULT 0
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER AS $$
DECLARE
    new_rub numeric;
    new_stars numeric;
BEGIN
    -- Защита от отрицательного баланса
    IF p_amount_rub < 0 THEN
        SELECT rub_balance INTO new_rub 
        FROM balances 
        WHERE user_id = p_user_id;

        IF new_rub IS NULL OR (new_rub + p_amount_rub) < 0 THEN
            RETURN json_build_object('ok', false, 'error', 'Insufficient RUB balance');
        END IF;
    END IF;

    IF p_amount_stars < 0 THEN
        SELECT stars_balance INTO new_stars 
        FROM balances 
        WHERE user_id = p_user_id;

        IF new_stars IS NULL OR (new_stars + p_amount_stars) < 0 THEN
            RETURN json_build_object('ok', false, 'error', 'Insufficient Stars balance');
        END IF;
    END IF;

    INSERT INTO balances (user_id, rub_balance, stars_balance, updated_at)
    VALUES (
        p_user_id, 
        GREATEST(0, COALESCE(p_amount_rub, 0)),
        GREATEST(0, COALESCE(p_amount_stars, 0)),
        NOW()
    )
    ON CONFLICT (user_id) DO UPDATE SET
        rub_balance = GREATEST(0, balances.rub_balance + EXCLUDED.rub_balance),
        stars_balance = GREATEST(0, balances.stars_balance + EXCLUDED.stars_balance),
        updated_at = NOW()
    RETURNING rub_balance, stars_balance 
    INTO new_rub, new_stars;

    RETURN json_build_object(
        'ok', true,
        'rub_balance', new_rub,
        'stars_balance', new_stars
    );

EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

--------------------------------------------------------------------------------
-- 2. submit_task_atomic
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION submit_task_atomic(
    p_user_id bigint,
    p_task_id uuid, -- Changed to UUID for database compatibility
    p_status text,
    p_proof_text text,
    p_proof_url text,
    p_reward_rub numeric DEFAULT 0,
    p_xp_added integer DEFAULT 0,
    p_ai_score integer DEFAULT 0
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER AS $$
DECLARE
    v_qty_left integer;
    v_task_status text;
BEGIN
    -- Проверяем задание
    SELECT qty_left, status INTO v_qty_left, v_task_status
    FROM tasks 
    WHERE id = p_task_id 
    FOR UPDATE;   -- важный lock

    IF v_task_status IS NULL OR v_task_status != 'active' OR v_qty_left <= 0 THEN
        RETURN json_build_object('ok', false, 'error', 'No slots available or task closed');
    END IF;

    -- Резервируем слот
    UPDATE tasks 
    SET qty_left = qty_left - 1,
        updated_at = NOW()
    WHERE id = p_task_id;

    -- Создаём запись выполнения
    INSERT INTO completions (task_id, user_id, status, proof_text, proof_url, reward_rub, xp_added, created_at)
    VALUES (p_task_id, p_user_id, p_status, p_proof_text, p_proof_url, p_reward_rub, p_xp_added, NOW());

    RETURN json_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

--------------------------------------------------------------------------------
-- 3. approve_proof_atomic
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION approve_proof_atomic(
    p_admin_id bigint,
    p_proof_id uuid, -- Changed to UUID
    p_reward_rub numeric,
    p_xp_added integer
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER AS $$
DECLARE
    v_comp record;
BEGIN
    SELECT * INTO v_comp 
    FROM completions 
    WHERE id = p_proof_id AND status IN ('pending', 'pending_hold')
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'Proof not found or already processed');
    END IF;

    -- Начисляем награду и XP
    PERFORM update_balance_atomic(v_comp.user_id, p_reward_rub, 0);
    
    -- Обновляем статус выполнения
    UPDATE completions 
    SET status = 'paid',
        moderated_by = p_admin_id,
        moderated_at = NOW(),
        reward_rub = p_reward_rub,
        xp_added = p_xp_added
    WHERE id = p_proof_id;

    RETURN json_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

--------------------------------------------------------------------------------
-- 4. reject_proof_atomic
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_proof_atomic(
    p_admin_id bigint,
    p_proof_id uuid,
    p_status text -- 'rejected', 'fake', or 'rework'
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER AS $$
DECLARE
    v_comp record;
    v_task_id uuid;
BEGIN
    SELECT * INTO v_comp 
    FROM completions 
    WHERE id = p_proof_id 
    FOR UPDATE;

    IF NOT FOUND OR v_comp.status NOT IN ('pending', 'pending_hold', 'rework') THEN
        RETURN json_build_object('ok', false, 'error', 'Proof not found or already processed');
    END IF;

    v_task_id := v_comp.task_id;

    UPDATE completions 
    SET status = p_status,
        moderated_by = p_admin_id,
        moderated_at = NOW()
    WHERE id = p_proof_id;

    -- Возвращаем слот в задание
    UPDATE tasks 
    SET qty_left = qty_left + 1,
        updated_at = NOW()
    WHERE id = v_task_id AND qty_left >= 0;

    -- If task was closed because qty_left became 0, reopen it
    UPDATE tasks 
    SET status = 'active'
    WHERE id = v_task_id AND status = 'closed' AND qty_left > 0;

    RETURN json_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

--------------------------------------------------------------------------------
-- 5. cancel_task_atomic
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cancel_task_atomic(
    p_owner_id BIGINT,
    p_task_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_qty_left INT;
    v_reward_rub NUMERIC;
    v_status TEXT;
    v_refund_amount NUMERIC;
BEGIN
    -- 1. Lock and check task status
    SELECT status, qty_left, reward_rub 
    INTO v_status, v_qty_left, v_reward_rub
    FROM tasks 
    WHERE id = p_task_id AND owner_id = p_owner_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Задание не найдено');
    END IF;

    IF v_status != 'active' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Задание уже неактивно');
    END IF;

    -- 2. Update task status
    UPDATE tasks 
    SET status = 'cancelled', qty_left = 0 
    WHERE id = p_task_id;

    -- 3. Calculate and apply refund
    v_refund_amount := ROUND((v_qty_left * v_reward_rub)::NUMERIC, 2);
    
    IF v_refund_amount > 0 THEN
        UPDATE balances 
        SET rub_balance = rub_balance + v_refund_amount 
        WHERE user_id = p_owner_id;
    END IF;

    RETURN jsonb_build_object('ok', true, 'refund_amount', v_refund_amount);
END;
$$;
