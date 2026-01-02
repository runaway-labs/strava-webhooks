'use strict';

require('dotenv').config();

// Imports dependencies and sets up http server
const
    express = require('express'),
    bodyParser = require('body-parser'),
    axios = require('axios'),
    querystring = require('querystring'),
    { createClient } = require('@supabase/supabase-js'),
    admin = require('firebase-admin'),
    rateLimit = require('express-rate-limit'),
    // creates express http server
    app = express().use(bodyParser.json());

// Rate limiting configuration
// General rate limiter - 100 requests per 15 minutes per IP
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true, // Return rate limit info in headers
    legacyHeaders: false, // Disable the X-RateLimit-* headers
    handler: (req, res) => {
        console.log(`⚠️ Rate limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ error: 'Too many requests, please try again later.' });
    }
});

// Stricter rate limiter for auth/OAuth endpoints - 20 requests per 15 minutes
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // limit each IP to 20 requests per windowMs
    message: { error: 'Too many authentication attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        console.log(`⚠️ Auth rate limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ error: 'Too many authentication attempts, please try again later.' });
    }
});

// Webhook-specific rate limiter - more permissive for Strava's retry logic
// 200 requests per minute per IP (Strava may send bursts of webhooks)
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 200, // limit each IP to 200 requests per windowMs
    message: { error: 'Too many webhook requests.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        // Skip rate limiting for Strava's verification GET requests
        return req.method === 'GET' && req.query['hub.mode'] === 'subscribe';
    },
    handler: (req, res) => {
        console.log(`⚠️ Webhook rate limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ error: 'Too many webhook requests.' });
    }
});

// Apply general rate limiter to all requests
app.use(generalLimiter);

// Initialize Firebase Admin SDK
// Auto-detects base64 or JSON format from FIREBASE_SERVICE_ACCOUNT
let firebaseInitialized = false;
try {
    let serviceAccount = null;
    const envValue = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT;

    if (envValue) {
        let jsonString = envValue;

        // Auto-detect: if it doesn't start with '{', assume it's base64
        if (!envValue.trim().startsWith('{')) {
            console.log('🔥 Detected base64 encoded service account, decoding...');
            jsonString = Buffer.from(envValue, 'base64').toString('utf-8');
        }

        serviceAccount = JSON.parse(jsonString);

        // Fix private_key if it has literal \n instead of actual newlines
        if (serviceAccount.private_key && serviceAccount.private_key.includes('\\n')) {
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        }
    }

    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        firebaseInitialized = true;
        console.log('🔥 Firebase Admin SDK initialized successfully');
    } else {
        console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not set - push notifications disabled');
    }
} catch (error) {
    console.error('❌ Failed to initialize Firebase Admin SDK:', error.message);
}

// Congratulatory messages for notifications
const congratulatoryTitles = [
    "You crushed it! 💪",
    "Another one in the books! 🔥",
    "Way to show up! 🏆",
    "Beast mode activated! 🦾",
    "Legend status! ⭐",
    "That's what champions do! 🥇",
    "Unstoppable! 🚀",
    "You're on fire! 🔥",
    "Keep that momentum! ⚡",
    "Nailed it! 🎯"
];

// Activity type display names
const activityTypeNames = {
    'Run': 'run',
    'Ride': 'ride',
    'Walk': 'walk',
    'Hike': 'hike',
    'VirtualRide': 'virtual ride',
    'VirtualRun': 'virtual run',
    'Swim': 'swim',
    'Workout': 'workout',
    'WeightTraining': 'strength session',
    'Yoga': 'yoga session',
    'Crossfit': 'CrossFit workout',
    'Elliptical': 'elliptical session',
    'Rowing': 'rowing session',
    'RockClimbing': 'climbing session',
    'AlpineSki': 'ski session',
    'Snowboard': 'snowboard session',
    'MountainBikeRide': 'mountain bike ride',
    'GravelRide': 'gravel ride',
    'TrailRun': 'trail run',
    'Golf': 'round of golf'
};

// Format distance for notification
function formatDistance(meters) {
    const miles = meters * 0.000621371;
    return miles.toFixed(1);
}

// Format duration for notification
function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes} min`;
}

// Send push notification for new activity
async function sendActivityNotification(athleteId, activityData) {
    if (!firebaseInitialized) {
        console.log('⚠️ Firebase not initialized - skipping notification');
        return;
    }

    try {
        // Get athlete's FCM token from Supabase
        const { data: athlete, error } = await supabase
            .from('athletes')
            .select('fcm_token, first_name')
            .eq('id', athleteId)
            .single();

        if (error || !athlete?.fcm_token) {
            console.log(`⚠️ No FCM token found for athlete ${athleteId} - skipping notification`);
            return;
        }

        const fcmToken = athlete.fcm_token;
        const firstName = athlete.first_name || 'Athlete';

        // Get activity details
        const activityType = activityData.sport_type || activityData.type || 'Workout';
        const activityName = activityTypeNames[activityType] || activityType.toLowerCase();
        const distance = activityData.distance || 0;
        const duration = activityData.moving_time || activityData.elapsed_time || 0;

        // Pick a random congratulatory title
        const title = congratulatoryTitles[Math.floor(Math.random() * congratulatoryTitles.length)];

        // Build dynamic body based on activity type
        let body;
        if (distance > 0) {
            body = `${firstName} just logged a ${formatDistance(distance)} mile ${activityName} in ${formatDuration(duration)}!`;
        } else {
            body = `${firstName} just crushed a ${formatDuration(duration)} ${activityName}!`;
        }

        // Send the notification
        const message = {
            token: fcmToken,
            notification: {
                title: title,
                body: body
            },
            data: {
                sync_type: 'new_activity',
                activity_id: activityData.id?.toString() || '',
                activity_type: activityType
            },
            apns: {
                payload: {
                    aps: {
                        sound: 'default',
                        badge: 1
                    }
                }
            }
        };

        const response = await admin.messaging().send(message);
        console.log(`✅ Push notification sent successfully: ${response}`);
        console.log(`   Title: ${title}`);
        console.log(`   Body: ${body}`);

    } catch (error) {
        console.error('❌ Failed to send push notification:', error.message);
        // Don't throw - notification failure shouldn't break the webhook
    }
}

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

        // Token refreshed successfully (token details not logged for security)

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

// OAuth callback endpoint (with stricter rate limiting)
app.get('/callback', authLimiter, async (req, res) => {
    const code = req.query.code;
    const state = req.query.state; // Contains auth_user_id from app

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
            auth_user_id: state || null, // Link to Supabase auth user
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
            token_expires_at: new Date(expires_at * 1000).toISOString(),
            strava_connected: true,
            strava_connected_at: new Date().toISOString()
        };

        const { error } = await supabase
            .from('athletes')
            .upsert(athleteData, { onConflict: 'id' });

        if (error) {
            throw error;
        }

        // Redirect back to app or show success page
        if (state) {
            // Deep link back to mobile app with auto-redirect HTML page
            const deepLink = `runaway://strava-connected?success=true&athlete_id=${athlete.id}`;
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Strava Connected</title>
                    <style>
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                            display: flex;
                            flex-direction: column;
                            align-items: center;
                            justify-content: center;
                            height: 100vh;
                            margin: 0;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            color: white;
                            text-align: center;
                            padding: 20px;
                        }
                        .container {
                            max-width: 400px;
                        }
                        h1 { font-size: 32px; margin-bottom: 20px; }
                        p { font-size: 18px; margin-bottom: 30px; opacity: 0.9; }
                        .button {
                            display: inline-block;
                            padding: 15px 40px;
                            background: white;
                            color: #667eea;
                            text-decoration: none;
                            border-radius: 25px;
                            font-weight: bold;
                            font-size: 16px;
                        }
                        .icon { font-size: 64px; margin-bottom: 20px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="icon">✓</div>
                        <h1>Connected to Strava!</h1>
                        <p>Your Strava account has been successfully connected.</p>
                        <a href="${deepLink}" class="button">Return to Runaway</a>
                        <p style="font-size: 14px; margin-top: 30px; opacity: 0.7;">
                            If you're not redirected automatically, tap the button above.
                        </p>
                    </div>
                    <script>
                        // Automatically attempt to open the app
                        window.location.href = '${deepLink}';

                        // Fallback: try again after a short delay
                        setTimeout(() => {
                            window.location.href = '${deepLink}';
                        }, 500);
                    </script>
                </body>
                </html>
            `);
        } else {
            res.send(`<h1>Success!</h1><p>Athlete ${athlete.firstname} ${athlete.lastname} (ID: ${athlete.id}) connected successfully. Tokens stored.</p>`);
        }
    } catch (error) {
        console.error('OAuth callback error:', error);
        res.status(500).send(`Error: ${error.message}`);
    }
});

// Disconnect endpoint - revokes Strava access (with stricter rate limiting)
app.post('/disconnect', authLimiter, async (req, res) => {
    try {
        const { athlete_id, auth_user_id } = req.body;

        if (!athlete_id && !auth_user_id) {
            return res.status(400).json({
                error: 'Either athlete_id or auth_user_id is required'
            });
        }

        // Find athlete by either athlete_id or auth_user_id
        let query = supabase.from('athletes').select('*');
        if (athlete_id) {
            query = query.eq('id', athlete_id);
        } else {
            query = query.eq('auth_user_id', auth_user_id);
        }

        const { data: athlete, error: fetchError } = await query.single();

        if (fetchError || !athlete) {
            return res.status(404).json({
                error: 'Athlete not found'
            });
        }

        // Revoke access with Strava (optional - requires access_token)
        if (athlete.access_token) {
            try {
                await axios.post('https://www.strava.com/oauth/deauthorize', null, {
                    headers: {
                        'Authorization': `Bearer ${athlete.access_token}`
                    }
                });
                console.log(`Revoked Strava access for athlete ${athlete.id}`);
            } catch (deauthError) {
                // Continue even if revocation fails (token may be expired)
                console.error('Strava deauthorization failed:', deauthError.message);
            }
        }

        // Update athlete record
        const { error: updateError } = await supabase
            .from('athletes')
            .update({
                strava_connected: false,
                strava_disconnected_at: new Date().toISOString(),
                access_token: null,
                refresh_token: null,
                token_expires_at: null
            })
            .eq('id', athlete.id);

        if (updateError) {
            throw updateError;
        }

        console.log(`Athlete ${athlete.id} disconnected from Strava`);
        res.status(200).json({
            success: true,
            message: 'Disconnected from Strava successfully',
            athlete_id: athlete.id
        });

    } catch (error) {
        console.error('Disconnect error:', error);
        res.status(500).json({
            error: 'Failed to disconnect from Strava',
            details: error.message
        });
    }
});

// Creates the endpoint for our webhook (with webhook-specific rate limiting)
app.post('/webhook', webhookLimiter, async (req, res) => {
    console.log("webhook event received!", req.query, req.body);

    // Handle deauthorization events
    if (req.body.aspect_type === 'update' && req.body.updates?.authorized === 'false') {
        const athleteId = req.body.owner_id;
        console.log(`Deauthorization event received for athlete ${athleteId}`);

        try {
            const { error } = await supabase
                .from('athletes')
                .update({
                    strava_connected: false,
                    strava_disconnected_at: new Date().toISOString(),
                    access_token: null,
                    refresh_token: null,
                    token_expires_at: null
                })
                .eq('id', athleteId);

            if (error) {
                console.error('Failed to process deauthorization:', error);
            } else {
                console.log(`Athlete ${athleteId} deauthorized successfully`);
            }

            return res.status(200).send('DEAUTH_PROCESSED');
        } catch (error) {
            console.error('Deauthorization error:', error);
            return res.status(200).send('DEAUTH_ERROR');
        }
    }

    if (req.body.aspect_type == 'create') {
        try {
            // Extract the activity ID and athlete ID from the request body
            const activityId = req.body.object_id;
            const athleteId = req.body.owner_id;

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

            // Check if athlete is still connected to Strava
            const { data: athlete, error: athleteCheckError } = await supabase
                .from('athletes')
                .select('strava_connected, auth_user_id')
                .eq('id', athleteId)
                .single();

            if (athleteCheckError) {
                console.error('Error checking athlete status:', athleteCheckError);
                return res.status(500).send('Error checking athlete status');
            }

            if (!athlete || !athlete.strava_connected) {
                console.log(`Ignoring webhook for disconnected athlete ${athleteId}`);
                return res.status(200).send('IGNORED_DISCONNECTED_USER');
            }

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

            // Access token obtained successfully (not logged for security)

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

                // Send push notification for the new activity
                await sendActivityNotification(athleteId, activityData);

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

// Adds support for GET requests to our webhook (verification endpoint)
app.get('/webhook', webhookLimiter, (req, res) => {
    // Verify token from environment variable (security fix)
    const VERIFY_TOKEN = process.env.STRAVA_VERIFY_TOKEN;

    if (!VERIFY_TOKEN) {
        console.error('❌ STRAVA_VERIFY_TOKEN environment variable not set!');
        return res.status(500).send('Server configuration error');
    }

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
        max_watts: record.max_watts ? Math.round(record.max_watts) : null,
        average_watts: record.average_watts ? Math.round(record.average_watts) : null,
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
        resource_state: 2,
        // Map polyline data
        map_polyline: record.map?.polyline || null,
        map_summary_polyline: record.map?.summary_polyline || null,
        start_latitude: record.start_latlng?.[0] || null,
        start_longitude: record.start_latlng?.[1] || null,
        end_latitude: record.end_latlng?.[0] || null,
        end_longitude: record.end_latlng?.[1] || null
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