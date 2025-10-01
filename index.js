'use strict';

require('dotenv').config();

// Imports dependencies and sets up http server
const
    express = require('express'),
    bodyParser = require('body-parser'),
    axios = require('axios'),
    querystring = require('querystring'),
    { createClient } = require('@supabase/supabase-js'),
    // creates express http server
    app = express().use(bodyParser.json());

// Strava API configuration
const STRAVA_API_BASE = "https://www.strava.com/api/v3";
const clientID = process.env.STRAVA_CLIENT_ID;
const clientSecret = process.env.STRAVA_CLIENT_SECRET;

// Supabase configuration
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

let accessToken = '';
let refreshToken = '';

// Add error handling helper
function handleError(error, res) {
    console.error('Error details:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status
    });

    if (error.response?.status === 401) {
        return res?.send('Authentication expired. Please login again at the home page.');
    }

    const errorMessage = error.response?.data?.message || error.message;
    return res?.send(`Error: ${errorMessage}`);
}

async function refreshAccessToken(athleteId) {
    try {
        if (!athleteId) {
            throw new Error('No athlete ID available for token refresh');
        }

        // Get stored refresh token from Supabase
        const { data: userData, error: fetchError } = await supabase
            .from('athletes')
            .select('refresh_token')
            .eq('id', athleteId)
            .single();

        if (fetchError || !userData?.refresh_token) {
            throw new Error(`No refresh token found for athlete ${athleteId}: ${fetchError?.message}`);
        }

        const storedRefreshToken = userData.refresh_token;
        console.log('Stored refresh token found for athlete:', athleteId);

        // Use the stored refresh token to get new access token from Strava
        const tokenResponse = await axios.post('https://www.strava.com/oauth/token', querystring.stringify({
            client_id: clientID,
            client_secret: clientSecret,
            refresh_token: storedRefreshToken,
            grant_type: 'refresh_token'
        })).catch(error => {
            throw new Error(`Strava token refresh failed: ${error.response?.data?.message || error.message}`);
        });

        console.log('Token response:', tokenResponse.data);

        accessToken = tokenResponse.data.access_token;
        refreshToken = tokenResponse.data.refresh_token;

        // Update the stored tokens in Supabase
        const { error: updateError } = await supabase
            .from('athletes')
            .update({
                access_token: accessToken,
                refresh_token: refreshToken,
                token_expires_at: new Date(tokenResponse.data.expires_at * 1000).toISOString()
            })
            .eq('id', athleteId);

        if (updateError) {
            console.error('Failed to update tokens in Supabase:', updateError.message);
            // Continue execution even if update fails
        }

        console.log('Token refreshed successfully');
        return accessToken;
    } catch (error) {
        console.error('Token refresh failed:', {
            error: error.message,
            athleteId
        });
        throw error;
    }
}

// Sets server port and logs message on success
app.listen(process.env.PORT || 8080, () => console.log('webhook is listening'));

// Root endpoint - show authorization link
app.get('/', (req, res) => {
    const redirectUri = `${req.protocol}://${req.get('host')}/callback`;
    const authUrl = `https://www.strava.com/oauth/authorize?client_id=${clientID}&response_type=code&redirect_uri=${redirectUri}&approval_prompt=force&scope=activity:read_all,profile:read_all`;
    res.send(`<h1>Strava Webhook Service</h1><p><a href="${authUrl}">Connect with Strava</a></p>`);
});

// OAuth callback endpoint
app.get('/callback', async (req, res) => {
    const code = req.query.code;

    if (!code) {
        return res.status(400).send('No authorization code provided');
    }

    try {
        // Exchange authorization code for tokens
        const tokenResponse = await axios.post('https://www.strava.com/oauth/token', {
            client_id: clientID,
            client_secret: clientSecret,
            code: code,
            grant_type: 'authorization_code'
        });

        const { access_token, refresh_token, expires_at, athlete } = tokenResponse.data;

        // Store tokens and athlete data in Supabase
        const athleteData = {
            id: athlete.id,
            first_name: athlete.firstname,
            last_name: athlete.lastname,
            email: athlete.email,
            sex: athlete.sex,
            weight: athlete.weight || 0,
            city: athlete.city,
            state: athlete.state,
            country: athlete.country,
            premium: athlete.premium || false,
            created_at: athlete.created_at,
            updated_at: new Date().toISOString(),
            access_token: access_token,
            refresh_token: refresh_token,
            token_expires_at: new Date(expires_at * 1000).toISOString()
        };

        const { error } = await supabase
            .from('athletes')
            .upsert(athleteData, { onConflict: 'id' });

        if (error) {
            throw error;
        }

        res.send(`<h1>Success!</h1><p>Athlete ${athlete.firstname} ${athlete.lastname} (ID: ${athlete.id}) connected successfully. Tokens stored.</p>`);
    } catch (error) {
        console.error('OAuth callback error:', error);
        res.status(500).send(`Error: ${error.message}`);
    }
});

// Creates the endpoint for our webhook
app.post('/webhook', async (req, res) => {
    console.log("webhook event received!", req.query, req.body);

    if (req.body.aspect_type == 'create') {
        try {
            // Extract the activity ID and athlete ID from the request body
            const activityId = req.body.object_id;
            const athleteId = req.body.owner_id;;

            console.log('Activity ID:', activityId);
            console.log('Athlete ID:', athleteId);

            if (!activityId) {
                console.error('No activity ID found in webhook payload');
                return res.status(400).send('No activity ID found');
            }

            if (!athleteId) {
                console.error('No athlete ID found in webhook payload');
                return res.status(400).send('No athlete ID found');
            }

            // Get fresh access token
            const accessToken = await refreshAccessToken(athleteId);

            console.log('Access token:', accessToken);

            // Make authenticated GET requests to Strava API
            const headers = {
                'Authorization': `Bearer ${accessToken}`
            };

            let activityData;
            try {
                console.log('Fetching activity from Strava API:', activityId);
                const activityResponse = await axios.get(`${STRAVA_API_BASE}/activities/${activityId}`, { headers });
                activityData = activityResponse.data;
                console.log('Activity details:', activityData);
            } catch (error) {
                console.error('Failed to fetch activity:', error.message);
                handleError(error, res);
                return;
            }

            // Fetch athlete details
            let athleteData;
            try {
                console.log('Fetching athlete from Strava API:', athleteId);
                const athleteResponse = await axios.get(`${STRAVA_API_BASE}/athlete`, { headers });
                athleteData = athleteResponse.data;
                console.log('Athlete details:', athleteData);
            } catch (error) {
                console.error('Failed to fetch athlete:', error.message);
                handleError(error, res);
                return;
            }

            // Note: Skipping athlete stats since we don't have that table in current schema

            // Save data to Supabase
            try {
                const transformedActivityData = transformActivityData(athleteId, activityData);
                const transformedAthleteData = transformAthleteData(athleteId, athleteData);

                console.log('Saving activity data:', transformedActivityData);
                console.log('Saving athlete data:', transformedAthleteData);

                // Save data to Supabase in parallel
                const [activityResult, athleteResult] = await Promise.all([
                    supabase.from('activities').upsert(transformedActivityData, { onConflict: 'id' }),
                    supabase.from('athletes').upsert(transformedAthleteData, { onConflict: 'id' })
                ]);

                // Check for errors
                const errors = [activityResult.error, athleteResult.error].filter(Boolean);
                if (errors.length > 0) {
                    console.error('Supabase errors:', errors);
                    throw new Error(`Failed to save data to Supabase: ${errors.map(e => e.message).join(', ')}`);
                }

                console.log('Data saved successfully to Supabase');
                console.log('Activity result:', activityResult.data);
                console.log('Athlete result:', athleteResult.data);
                res.status(200).send('EVENT_RECEIVED');
            } catch (error) {
                console.error('Failed to save data to Supabase:', error.message);
                handleError(error, res);
                return;
            }
        } catch (error) {
            console.error('Error processing webhook:', error);
            handleError(error, res);
        }
    }
});

// Adds support for GET requests to our webhook
app.get('/webhook', (req, res) => {
    // Your verify token. Should be a random string.
    const VERIFY_TOKEN = "at8rQqYOpROWL6HNgEXiiXb6ky2dhWcu";
    // Parses the query params
    let mode = req.query['hub.mode'];
    let token = req.query['hub.verify_token'];
    let challenge = req.query['hub.challenge'];
    // Checks if a token and mode is in the query string of the request
    if (mode && token) {
        // Verifies that the mode and token sent are valid
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            // Responds with the challenge token from the request
            console.log('WEBHOOK_VERIFIED');
            res.json({ "hub.challenge": challenge });
        } else {
            // Responds with '403 Forbidden' if verify tokens do not match
            res.sendStatus(403);
        }
    }
});

// Map Strava sport_type to activity_type_id
function getActivityTypeId(sportType) {
    const typeMap = {
        'Run': 103,
        'Ride': 104,
        'Walk': 105,
        'Hike': 106,
        'VirtualRide': 107,
        'VirtualRun': 108,
        'Swim': 109,
        'Workout': 110,
        'WeightTraining': 111,
        'Yoga': 112,
        'Crossfit': 113,
        'Elliptical': 114,
        'Rowing': 115,
        'RockClimbing': 116,
        'AlpineSki': 117,
        'Snowboard': 118,
        'MountainBikeRide': 119,
        'GravelRide': 120,
        'TrailRun': 121,
        'Golf': 123
    };
    return typeMap[sportType] || 110; // Default to Workout (110) if unknown
}

// create a function that gets the full bodu of the strava activity by the activity id
function transformActivityData(athleteId, record) {
    const transformedData = {
        id: record.id,
        athlete_id: athleteId,
        name: record.name,
        description: record.description || '',
        activity_type_id: getActivityTypeId(record.sport_type || record.type),
        activity_date: record.start_date,
        start_time: record.start_date_local,
        elapsed_time: record.elapsed_time,
        moving_time: record.moving_time,
        distance: record.distance,
        elevation_gain: record.total_elevation_gain,
        elevation_high: record.elev_high,
        elevation_low: record.elev_low,
        max_speed: record.max_speed,
        average_speed: record.average_speed,
        max_heart_rate: record.max_heartrate ? Math.round(record.max_heartrate) : null,
        average_heart_rate: record.average_heartrate ? Math.round(record.average_heartrate) : null,
        has_heartrate: record.has_heartrate || false,
        max_watts: record.max_watts,
        average_watts: record.average_watts,
        device_watts: record.device_watts || false,
        calories: record.calories || 1,
        commute: record.commute || false,
        flagged: record.flagged || false,
        trainer: record.trainer || false,
        manual: record.manual || false,
        private: record.private || false,
        external_id: record.id?.toString(),
        filename: record.upload_id ? `activities/${record.upload_id}.fit.gz` : null,
        from_upload: true,
        resource_state: 2
    };

    // Convert any undefined values to null
    Object.keys(transformedData).forEach(key => {
        if (transformedData[key] === undefined) {
            transformedData[key] = null;
        }
    });

    return transformedData;
}

function transformAthleteData(athleteId, athleteData) {
    const transformedData = {
        id: athleteId,
        first_name: athleteData.firstname,
        last_name: athleteData.lastname,
        email: athleteData.email,
        sex: athleteData.sex,
        weight: athleteData.weight || 0,
        city: athleteData.city,
        state: athleteData.state,
        country: athleteData.country,
        premium: athleteData.premium || false,
        created_at: athleteData.created_at,
        updated_at: new Date().toISOString()
    };

    // Convert any undefined values to null
    Object.keys(transformedData).forEach(key => {
        if (transformedData[key] === undefined) {
            transformedData[key] = null;
        }
    });

    return transformedData;
}

// Note: athlete_stats and maps tables are not available in current schema
// These functions have been removed to match the existing database structure