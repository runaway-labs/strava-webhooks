-- Migration script for existing Strava webhook users
-- Run this after deploying the schema changes from supabase-migration.sql

-- Step 1: Mark all users with valid refresh tokens as connected
-- This assumes that if they have a refresh_token, they previously authorized Strava
UPDATE athletes
SET
    strava_connected = true,
    strava_connected_at = COALESCE(created_at, NOW())
WHERE
    refresh_token IS NOT NULL
    AND refresh_token != ''
    AND (strava_connected IS NULL OR strava_connected = false);

-- Step 2: Mark users without refresh tokens as not connected
UPDATE athletes
SET
    strava_connected = false,
    strava_disconnected_at = NOW()
WHERE
    (refresh_token IS NULL OR refresh_token = '')
    AND (strava_connected IS NULL OR strava_connected = true);

-- Step 3: Verify migration results
SELECT
    COUNT(*) as total_athletes,
    SUM(CASE WHEN strava_connected = true THEN 1 ELSE 0 END) as connected_athletes,
    SUM(CASE WHEN strava_connected = false THEN 1 ELSE 0 END) as disconnected_athletes,
    SUM(CASE WHEN strava_connected IS NULL THEN 1 ELSE 0 END) as null_status_athletes
FROM athletes;

-- Step 4: Show sample of migrated data
SELECT
    id,
    first_name,
    last_name,
    strava_connected,
    strava_connected_at,
    strava_disconnected_at,
    CASE
        WHEN refresh_token IS NOT NULL THEN 'Has token'
        ELSE 'No token'
    END as token_status
FROM athletes
ORDER BY strava_connected DESC, id
LIMIT 10;
