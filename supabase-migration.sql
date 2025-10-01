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
ADD COLUMN IF NOT EXISTS weight NUMERIC DEFAULT 0;

-- Create index on athlete_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_athletes_id ON athletes(id);
