-- Create or update athletes table with all required columns
CREATE TABLE IF NOT EXISTS athletes (
    id BIGINT PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    email TEXT,
    sex TEXT,
    weight NUMERIC DEFAULT 0,
    city TEXT,
    state TEXT,
    country TEXT,
    premium BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TIMESTAMPTZ
);

-- Add missing columns if table already exists
ALTER TABLE athletes
ADD COLUMN IF NOT EXISTS access_token TEXT,
ADD COLUMN IF NOT EXISTS refresh_token TEXT,
ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS premium BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS weight NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS auth_user_id UUID,
ADD COLUMN IF NOT EXISTS strava_connected BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS strava_connected_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS strava_disconnected_at TIMESTAMPTZ;

-- Create index on athlete_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_athletes_id ON athletes(id);

-- Create index on auth_user_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_athletes_auth_user_id ON athletes(auth_user_id);

-- Add foreign key constraint to link athletes to auth.users
ALTER TABLE athletes
ADD CONSTRAINT fk_athletes_auth_user
FOREIGN KEY (auth_user_id)
REFERENCES auth.users(id)
ON DELETE SET NULL;

-- Backfill strava_connected flag for existing users with tokens
UPDATE athletes
SET strava_connected = true,
    strava_connected_at = COALESCE(created_at, NOW())
WHERE refresh_token IS NOT NULL
  AND strava_connected IS NULL;
