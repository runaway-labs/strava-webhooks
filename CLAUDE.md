# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Node.js webhook service that bridges Strava's webhook system with a downstream "Runaway" application. It processes real-time Strava activity updates, handles OAuth token refresh, fetches detailed data from Strava's API, transforms the data, and syncs it with the Runaway service.

## Development Commands

- `npm start` - Start the webhook service (runs `node index.js`)
- `node index.js` - Direct execution of the main application

Note: No build, test, or lint scripts are configured in this project.

## Architecture

### Single-File Monolith Structure
The entire application logic resides in `index.js` (~346 lines). Key components:

- **Express server** with two endpoints:
  - `GET /webhook` - Webhook verification for Strava
  - `POST /webhook` - Processes incoming webhook events
- **OAuth token management** - Automatic refresh using stored refresh tokens
- **Data transformation functions** - 4 transformation functions mapping Strava API format to Supabase schema
- **External service integration** - Communicates directly with Strava API v3 and Supabase database

### Data Flow
1. Receives Strava webhook event
2. Refreshes OAuth tokens if needed (stored in Supabase)
3. Fetches detailed activity/athlete data from Strava API v3
4. Transforms data using dedicated transformation functions
5. Saves transformed data directly to Supabase database

### External Dependencies
- **Strava API v3**: `https://www.strava.com/api/v3`
- **Strava OAuth**: `https://www.strava.com/oauth/token`
- **Supabase**: Database and backend services

## Environment Configuration

Required environment variables:
- `STRAVA_CLIENT_ID` - Strava API client ID
- `STRAVA_CLIENT_SECRET` - Strava API client secret
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_KEY` - Supabase service role key for server-side operations
- `PORT` - Server port (defaults to 8080)

## Key Implementation Details

### Webhook Verification
- Uses hardcoded verification token: `"at8rQqYOpROWL6HNgEXiiXb6ky2dhWcu"`
- Handles Strava's hub challenge verification

### Data Transformations
The service includes sophisticated transformation functions for:
- **Activities** - Maps comprehensive activity data with null handling
- **Athletes** - Transforms profile and demographic data
- **Athlete Statistics** - Processes running totals and year-to-date stats
- **Maps** - Handles polyline data for route visualization

### Database Schema
The Supabase database includes these tables:
- **athletes** - Stores athlete profiles and OAuth tokens
- **activities** - Stores activity data from Strava webhooks
- **athlete_stats** - Stores athlete running statistics
- **maps** - Stores polyline data for activity routes

Run `supabase-migration.sql` in your Supabase SQL Editor to create the schema.

### Error Handling
- Centralized error handler with specific authentication error detection
- Automatic OAuth token refresh on authentication failures

## Deployment

- Configured for Google Cloud Platform deployment (`.gcloudignore` present)
- Node.js 16.x runtime requirement specified in `package.json`
- No CI/CD pipeline configured

## Development Notes

- No test suite or linting configuration
- Single-file architecture makes the codebase easy to understand but harder to maintain
- Recent git history shows ongoing improvements to authentication and data parsing
- Consider modularization if adding significant new features