/**
 * @file index.js
 * @brief Main backend server for hotel access control and monitoring.
 * @version 1.0.1
 */

const express = require('express');
const http = require('http');
const aedes = require('aedes')();
const WebSocket = require('ws');
const net = require('net');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// HTTP / MQTT ports (PORT is provided by Render in production)
const httpPort = process.env.PORT || 3000;
const mqttPort = process.env.MQTT_PORT || 1883;

// CORS: allowed origins for browser and SSE clients
const corsOrigins = [
  'https://hotel-frontend-two-puce.vercel.app',
  'https://hotel-backend-5kcn.onrender.com',
  'https://hotel-mng-frontend-i3ed.vercel.app',
  'http://localhost:3001',
  'http://localhost:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3000',
  'https://hotelmng-git-main-jivis-projects-13189c75.vercel.app'
];
if (process.env.FRONTEND_URL) corsOrigins.push(process.env.FRONTEND_URL);

if (process.env.NODE_ENV !== 'production') {
  app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));
} else {
  app.use(cors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));
}


app.use(express.json());

// Security headers - Configure helmet to allow WebSocket upgrades
app.use(helmet({
  contentSecurityPolicy: false,  // Disable CSP for WebSocket
  crossOriginEmbedderPolicy: false  // Allow cross-origin for ESP32
}));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Server is running', 
    timestamp: new Date().toISOString(),
    endpoints: {
      api: '/api',
      websocket: '/ws',
      mqtt: '/mqtt'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

/**
 * SSE endpoint for per-hotel real-time updates.
 */
app.get('/api/events/:hotelId', (req, res) => {
  const hotelId = req.params.hotelId;
  
  // Validate hotel ID format (positive integer)
  if (!hotelId || !/^[1-9][0-9]*$/.test(hotelId)) {
    return res.status(400).json({ error: 'Invalid hotel ID' });
  }
  
  try {
    let allowedOrigin = '*';
    if (process.env.NODE_ENV === 'production' && corsOrigins.length > 0) {
      const requestOrigin = req.headers.origin;
      if (requestOrigin && corsOrigins.includes(requestOrigin)) {
        allowedOrigin = requestOrigin;
      } else {
        allowedOrigin = corsOrigins[0];
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Headers': 'Cache-Control',
      'X-Accel-Buffering': 'no' // Disable nginx buffering
    });

    // Send initial connection message
    const initialMessage = `data: ${JSON.stringify({ 
      event: 'connected', 
      data: { message: 'SSE connected successfully', hotelId } 
    })}\n\n`;
    
    res.write(initialMessage);
    console.log(`📡 SSE client connected for hotel ${hotelId}`);

    // Store client for broadcasting
    const clientId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    if (!global.sseClients) {
      global.sseClients = new Map();
    }
    global.sseClients.set(clientId, { res, hotelId, connected: true });

    // Send periodic heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      try {
        if (res.writable && global.sseClients && global.sseClients.has(clientId)) {
          res.write(`: heartbeat\n\n`);
        } else {
          clearInterval(heartbeat);
        }
      } catch (error) {
        console.error('Heartbeat error:', error.message);
        clearInterval(heartbeat);
        if (global.sseClients) {
          global.sseClients.delete(clientId);
        }
      }
    }, 30000); // Send heartbeat every 30 seconds

    // Handle client disconnect
    req.on('close', () => {
      console.log(`📡 SSE client disconnected for hotel ${hotelId}`);
      clearInterval(heartbeat);
      if (global.sseClients) {
        global.sseClients.delete(clientId);
      }
    });

    req.on('error', (err) => {
      // Only log non-ECONNRESET errors as they're normal for client disconnects
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        console.error('SSE client error:', err.message);
      }
      clearInterval(heartbeat);
      if (global.sseClients) {
        global.sseClients.delete(clientId);
      }
    });

    // Handle response errors
    res.on('error', (err) => {
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        console.error('SSE response error:', err.message);
      }
      clearInterval(heartbeat);
      if (global.sseClients) {
        global.sseClients.delete(clientId);
      }
    });
    
  } catch (error) {
    console.error('Error setting up SSE connection:', error.message);
    res.status(500).json({ error: 'Failed to establish SSE connection' });
  }
});

/**
 * Validate :hotelId route parameter.
 */
const validateHotelId = (req, res, next) => {
  const hotelId = req.params.hotelId;
  if (!hotelId || !/^[1-9][0-9]*$/.test(hotelId)) {
    return res.status(400).json({ error: 'Invalid hotel ID' });
  }
  next();
};

/**
 * Ensure MongoDB connection is ready before handling API requests.
 */
const checkDatabaseConnection = (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'Database not connected' });
  }
  next();
};

// Basic rate limiting for browser/API clients (does not apply to device ingestion endpoints)
const browserApiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 300, // limit each IP to 300 requests per minute on browser-facing APIs
  standardHeaders: true,
  legacyHeaders: false,
});

app.use([
  '/api/hotel',
  '/api/rooms',
  '/api/activity',
  '/api/settings',
  '/api/users',
  '/api/cards',
  '/api/power',
  '/api/alerts',
  '/api/denied_access',
  '/api/attendance',
], browserApiLimiter);

// Apply middleware to all API routes
app.use('/api', checkDatabaseConnection);

/**
 * Connect to MongoDB using the MONGO_URL environment variable.
 */
const mongoUrl = process.env.MONGO_URL;
if (!mongoUrl) {
  console.error('MONGO_URL environment variable is not set. Please configure it in your environment or .env file.');
  process.exit(1);
}

mongoose.connect(mongoUrl)
  .then(() => {
    const description = mongoUrl.includes('mongodb+srv') ? 'Atlas Cluster' : 'Configured MongoDB instance';
    console.log('Connected to MongoDB:', description);
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    console.log('Please make sure MongoDB is running or update MONGO_URL in .env file');
  });

// Models
const {
  Hotel,
  Room,
  Attendance,
  Alert,
  Denied,
  User,
  Card,
  Activity,
  PowerLog,
  Settings,
} = require('./models');

// Helper to map raw role values from devices to normalized access types
function getAccessType(role) {
  if (!role) return 'unknown';
  const normalized = role.toLowerCase();
  if (normalized === 'guest') return 'guest';
  if (normalized === 'maintenance' || normalized === 'housekeeping') return 'housekeeping';
  if (normalized === 'manager' || normalized === 'master') return 'master';
  return 'unknown';
}

// Minimum housekeeping duration (in seconds) required for a room to become vacant
const MIN_CLEANING_DURATION_SECONDS = 20 * 60; // 20 minutes

// Threshold below which we consider power usage to be "low" (in amps, approximate)
const LOW_POWER_CURRENT_THRESHOLD = 0.2;

async function getSettingsForHotel(hotelId) {
  const defaults = {
    minCleaningDurationSeconds: MIN_CLEANING_DURATION_SECONDS,
    lowPowerCurrentThreshold: LOW_POWER_CURRENT_THRESHOLD,
  };

  if (!hotelId) {
    return defaults;
  }

  try {
    const settings = await Settings.findOne({ hotelId });
    if (!settings) return defaults;

    return {
      minCleaningDurationSeconds: settings.minCleaningDurationSeconds || MIN_CLEANING_DURATION_SECONDS,
      lowPowerCurrentThreshold: settings.lowPowerCurrentThreshold || LOW_POWER_CURRENT_THRESHOLD,
    };
  } catch (error) {
    console.error('Error loading settings for hotel', hotelId, error);
    return defaults;
  }
}

/**
 * Seed default hotel metadata into the database.
 */
async function initializeHotels() {
  const hotels = [
    {
      id: "1",
      name: "Coastal Grand Hotel - Ooty",
      location: "Ooty, Tamil Nadu",
      address: "456 Hill Road, Ooty, Tamil Nadu",
      phone: "+91 90476 28844",
      email: "rajesh.kumar@coastalgrand.com",
      rating: 4.7,
      description: "Scenic hill station hotel with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "active",
      lastActivity: "2 minutes ago",
      manager: {
        name: "Rajesh Kumar",
        phone: "+91 90476 28844",
        email: "rajesh.kumar@coastalgrand.com",
        status: "online",
      },
    },
    {
      id: "2",
      name: "Coastal Grand Hotel - Salem",
      location: "Salem, Tamil Nadu",
      address: "123 Main Street, Salem, Tamil Nadu",
      phone: "+91 90476 28844",
      email: "priya.devi@coastalgrand.com",
      rating: 4.8,
      description: "Premium hotel in the heart of Salem with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "active",
      lastActivity: "5 minutes ago",
      manager: {
        name: "Priya Devi",
        phone: "+91 90476 28844",
        email: "priya.devi@coastalgrand.com",
        status: "online",
      },
    },
    {
      id: "3",
      name: "Coastal Grand Hotel - Yercaud",
      location: "Yercaud, Tamil Nadu",
      address: "789 Mountain View, Yercaud, Tamil Nadu",
      phone: "+91 90476 28844",
      email: "arun.balaji@coastalgrand.com",
      rating: 4.6,
      description: "Scenic hill station hotel with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "active",
      lastActivity: "10 minutes ago",
      manager: {
        name: "Arun Balaji",
        phone: "+91 90476 28844",
        email: "arun.balaji@coastalgrand.com",
        status: "online",
      },
    },
    {
      id: "4",
      name: "Coastal Grand Hotel - Puducherry",
      location: "Puducherry, Union Territory",
      address: "321 Beach Road, Puducherry, Union Territory",
      phone: "+91 90476 28844",
      email: "lakshmi.priya@coastalgrand.com",
      rating: 4.5,
      description: "Heritage hotel with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "maintenance",
      lastActivity: "1 hour ago",
      manager: {
        name: "Lakshmi Priya",
        phone: "+91 90476 28844",
        email: "lakshmi.priya@coastalgrand.com",
        status: "online",
      },
    },
    {
      id: "5",
      name: "Coastal Grand Hotel - Namakkal",
      location: "Namakkal, Tamil Nadu",
      address: "654 City Center, Namakkal, Tamil Nadu",
      phone: "+91 90476 28844",
      email: "senthil.kumar@coastalgrand.com",
      rating: 4.4,
      description: "Premium hotel with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "active",
      lastActivity: "15 minutes ago",
      manager: {
        name: "Senthil Kumar",
        phone: "+91 90476 28844",
        email: "senthil.kumar@coastalgrand.com",
        status: "online",
      },
    },
    {
      id: "6",
      name: "Coastal Grand Hotel - Chennai",
      location: "Chennai, Tamil Nadu",
      address: "987 Marina Beach Road, Chennai, Tamil Nadu",
      phone: "+91 90476 28844",
      email: "vijay.anand@coastalgrand.com",
      rating: 4.9,
      description: "Metropolitan hotel with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "active",
      lastActivity: "30 minutes ago",
      manager: {
        name: "Vijay Anand",
        phone: "+91 90476 28844",
        email: "vijay.anand@coastalgrand.com",
        status: "online",
      },
    },
    {
      id: "7",
      name: "Coastal Grand Hotel - Bangalore",
      location: "Bangalore, Karnataka",
      address: "147 MG Road, Bangalore, Karnataka",
      phone: "+91 90476 28844",
      email: "deepa.sharma@coastalgrand.com",
      rating: 4.7,
      description: "Metropolitan hotel with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "active",
      lastActivity: "45 minutes ago",
      manager: {
        name: "Deepa Sharma",
        phone: "+91 90476 28844",
        email: "deepa.sharma@coastalgrand.com",
        status: "online",
      },
    },
    {
      id: "8",
      name: "Coastal Grand Hotel - Kotagiri",
      location: "Kotagiri, Tamil Nadu",
      address: "258 Tea Estate Road, Kotagiri, Tamil Nadu",
      phone: "+91 90476 28844",
      email: "mohan.raj@coastalgrand.com",
      rating: 4.6,
      description: "Scenic hill station hotel with modern amenities and exceptional service.",
      image: "/placeholder.jpg",
      status: "active",
      lastActivity: "1 hour ago",
      manager: {
        name: "Mohan Raj",
        phone: "+91 90476 28844",
        email: "mohan.raj@coastalgrand.com",
        status: "online",
      },
    },
  ];

  for (const hotel of hotels) {
    await Hotel.findOneAndUpdate({ id: hotel.id }, hotel, { upsert: true });
  }
  console.log("Hotels initialized");
}

/**
 * Initialize room documents for all hotels with default vacant state.
 */
async function initializeRooms() {
  const hotels = await Hotel.find();
  
  for (const hotel of hotels) {
    const hotelId = hotel.id;
    const roomCount = getRoomCountForHotel(hotelId);
    
    // Generate realistic room numbers: 101-115 for floor 1, 201-215 for floor 2
    const roomsPerFloor = Math.ceil(roomCount / 2); // Split rooms between 2 floors
    let roomId = 1;
    
    // Floor 1: 101-115
    for (let i = 101; i <= 100 + roomsPerFloor; i++) {
      const roomData = {
        hotelId: hotelId,
        id: roomId,
        number: i.toString(),
        status: 'vacant',
        hasMasterKey: false,
        hasLowPower: false,
        powerStatus: 'off',
        occupantType: null,
      };
      
      await Room.findOneAndUpdate(
        { hotelId: hotelId, number: i.toString() },
        roomData,
        { upsert: true }
      );
      roomId++;
    }
    
    // Floor 2: 201-215 (if needed)
    if (roomCount > roomsPerFloor) {
      const remainingRooms = roomCount - roomsPerFloor;
      for (let i = 201; i <= 200 + remainingRooms; i++) {
        const roomData = {
          hotelId: hotelId,
          id: roomId,
          number: i.toString(),
          status: 'vacant',
          hasMasterKey: false,
          hasLowPower: false,
          powerStatus: 'off',
          occupantType: null,
        };
        
        await Room.findOneAndUpdate(
          { hotelId: hotelId, number: i.toString() },
          roomData,
          { upsert: true }
        );
        roomId++;
      }
    }
  }
  console.log("Rooms initialized for all hotels");
}

/**
 * Get configured room count for a given hotel id.
 * @param {string} hotelId
 * @returns {number}
 */
function getRoomCountForHotel(hotelId) {
  const roomCounts = {
    "1": 25, // Ooty
    "2": 30, // Salem
    "3": 20, // Yercaud
    "4": 28, // Puducherry
    "5": 22, // Namakkal
    "6": 30, // Chennai
    "7": 30, // Bangalore
    "8": 18, // Kotagiri
  };
  return roomCounts[hotelId] || 20;
}

mongoose.connection.once('open', async () => {
  await initializeHotels();
  await initializeRooms();
});


const server = http.createServer(app);

// Create WebSocket server for MQTT (ESP32) - NOT using Aedes
const mqttWsServer = new WebSocket.Server({
  noServer: true  // Don't auto-attach to server
});

// Manually handle WebSocket upgrade for /mqtt path
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  
  if (pathname === '/mqtt') {
    mqttWsServer.handleUpgrade(request, socket, head, (ws) => {
      mqttWsServer.emit('connection', ws, request);
    });
  } else if (pathname === '/ws') {
    frontendWsServer.handleUpgrade(request, socket, head, (ws) => {
      frontendWsServer.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Frontend WebSocket server for real-time updates
const frontendWsServer = new WebSocket.Server({
  noServer: true  // Don't auto-attach, use manual upgrade handler above
});

// Store frontend clients separately
const frontendClients = new Set();

// Handle frontend WebSocket connections
frontendWsServer.on('connection', function(ws, req) {
  const clientIP = req.socket.remoteAddress;
  const origin = req.headers.origin;
  console.log(`🔗 Frontend client connected via WebSocket from ${clientIP}, origin: ${origin}`);
  
  // Set connection timeout
  const connectionTimeout = setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'Connection timeout');
    }
  }, 300000); // 5 minutes timeout
  
  frontendClients.add(ws);
  
  try {
    // Send initial connection confirmation
    ws.send(JSON.stringify({ 
      event: 'connected', 
      data: { message: 'WebSocket connected successfully' } 
    }));
  } catch (error) {
    console.error('Error sending initial WebSocket message:', error.message);
    frontendClients.delete(ws);
    clearTimeout(connectionTimeout);
    return;
  }
  
  // Set up ping/pong for connection health
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch (error) {
        console.error('WebSocket ping error:', error.message);
        clearInterval(pingInterval);
        clearTimeout(connectionTimeout);
        frontendClients.delete(ws);
      }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000); // Ping every 30 seconds
  
  ws.on('pong', () => {
    // Reset timeout on pong response
    clearTimeout(connectionTimeout);
  });
  
  ws.on('close', (code, reason) => {
    console.log(`📡 Frontend WebSocket client disconnected: ${code} ${reason?.toString() || 'No reason'}`);
    clearInterval(pingInterval);
    clearTimeout(connectionTimeout);
    frontendClients.delete(ws);
  });
  
  ws.on('error', (error) => {
    // Only log non-connection reset errors
    if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') {
      console.error('Frontend WebSocket error:', error.message);
    }
    clearInterval(pingInterval);
    clearTimeout(connectionTimeout);
    frontendClients.delete(ws);
  });
});

frontendWsServer.on('error', (error) => {
  console.error('Frontend WebSocket Server error:', error);
});

console.log('Frontend WebSocket server initialized on /ws endpoint');

/**
 * Broadcast an event to all connected WebSocket and SSE clients.
 * @param {string} event - Event name (e.g. "roomUpdate:1").
 * @param {*} data - Payload to send to clients.
 */
function broadcastToClients(event, data) {
  const message = JSON.stringify({ event, data });
  console.log(`Broadcasting to ${frontendClients.size} WebSocket clients and ${global.sseClients ? global.sseClients.size : 0} SSE clients:`, { event, data });
  
  // Broadcast to WebSocket clients with improved error handling
  const disconnectedWsClients = [];
  frontendClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (error) {
        // Only log non-connection errors
        if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') {
          console.error('Error broadcasting to WebSocket client:', error.message);
        }
        disconnectedWsClients.push(client);
      }
    } else {
      disconnectedWsClients.push(client);
    }
  });
  
  // Clean up disconnected WebSocket clients
  disconnectedWsClients.forEach(client => frontendClients.delete(client));

  // Broadcast to SSE clients with improved error handling
  if (global.sseClients && global.sseClients.size > 0) {
    const sseMessage = `data: ${message}\n\n`;
    const disconnectedSseClients = [];
    
    global.sseClients.forEach((client, clientId) => {
      try {
        // Check if response is still writable
        if (client.res && client.res.writable && client.connected !== false) {
          client.res.write(sseMessage);
        } else {
          disconnectedSseClients.push(clientId);
        }
      } catch (error) {
        // Only log non-connection errors
        if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_WRITE_AFTER_END') {
          console.error('Error broadcasting to SSE client:', error.message);
        }
        disconnectedSseClients.push(clientId);
      }
    });
    
    // Clean up disconnected SSE clients
    disconnectedSseClients.forEach(clientId => {
      if (global.sseClients) {
        global.sseClients.delete(clientId);
      }
    });
  }
}

mqttWsServer.on('connection', function(ws, req) {
  console.log('🔗 MQTT client connected via WebSocket');
  
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message.toString());
      
      if (msg.cmd === 'publish' && msg.topic && msg.payload) {
        console.log(`📨 JSON-MQTT publish: ${msg.topic}`);
        
        // Parse payload
        let payloadData;
        try {
          payloadData = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
        } catch (e) {
          payloadData = msg.payload;
        }
        
        // Process MQTT message in background
        if (msg.topic.startsWith('campus/room/')) {
          const [, , building, floor, roomNum, type] = msg.topic.split('/');
          if (floor && roomNum && type) {
            payloadData.room = roomNum;
            payloadData.hotelId = floor;
            
            // Process without blocking
            processMqttMessage(msg.topic, payloadData).catch(err => {
              console.error('Error processing MQTT:', err.message);
            });
          }
        }
        
        // Send immediate acknowledgment
        ws.send(JSON.stringify({ status: 'ok', topic: msg.topic }));
      } else if (msg.cmd === 'subscribe') {
        ws.send(JSON.stringify({ status: 'ok', subscribed: msg.topics }));
      }
    } catch (error) {
      console.error('Message error:', error.message);
    }
  });
  
  ws.on('close', () => {
    console.log('📡 MQTT WebSocket client disconnected');
  });
  
  ws.on('error', (error) => {
    if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') {
      console.error('MQTT WebSocket error:', error.message);
    }
  });
});

// Process MQTT messages from ESP32
async function processMqttMessage(topic, data) {
  try {
    const [, , building, floor, roomNum, type] = topic.split('/');
    
    if (type === 'attendance') {
      const accessType = getAccessType(data.role);
      data.accessType = accessType;
      await new Attendance(data).save();
      console.log(`Saved attendance for room ${roomNum}`);
      
      // Update room status
      const { minCleaningDurationSeconds } = await getSettingsForHotel(data.hotelId);
      let update = {};
      
      if (data.check_in) {
        if (accessType === 'guest') {
          update = { status: 'occupied', occupantType: 'guest', powerStatus: 'on' };
        } else if (accessType === 'housekeeping') {
          update = { status: 'cleaning', occupantType: 'housekeeping', powerStatus: 'on', cleaningStartTime: data.check_in };
        } else if (accessType === 'master') {
          update = { hasMasterKey: true };
        }
      } else {
        if (accessType === 'guest') {
          update = { status: 'dirty', occupantType: null, powerStatus: 'off' };
        } else if (accessType === 'housekeeping') {
          update = { status: 'vacant', occupantType: null, powerStatus: 'off', cleaningStartTime: null };
        } else if (accessType === 'master') {
          update = { hasMasterKey: false };
        }
      }
      
      update.lastSeenAt = new Date().toISOString();
      await Room.findOneAndUpdate({ hotelId: data.hotelId, number: roomNum }, update, { upsert: true });
      broadcastToClients(`roomUpdate:${data.hotelId}`, { roomNum, ...update });
      
      // Create activity
      const activity = {
        hotelId: data.hotelId,
        id: Date.now().toString(),
        type: data.check_in ? 'checkin' : 'checkout',
        action: `${data.role} checked ${data.check_in ? 'in' : 'out'} to Room ${data.room}`,
        user: data.role,
        time: data.check_in || data.check_out
      };
      await new Activity(activity).save();
      broadcastToClients(`activityUpdate:${data.hotelId}`, activity);
    } else if (type === 'power') {
      const current = Number(data.current || 0);
      await new PowerLog({ hotelId: data.hotelId, room: roomNum, current, timestamp: data.timestamp || new Date().toISOString() }).save();
      
      const { lowPowerCurrentThreshold } = await getSettingsForHotel(data.hotelId);
      const update = { hasLowPower: current > 0 && current <= lowPowerCurrentThreshold, lastSeenAt: new Date().toISOString() };
      await Room.findOneAndUpdate({ hotelId: data.hotelId, number: roomNum }, update, { upsert: true });
      broadcastToClients(`roomUpdate:${data.hotelId}`, { roomNum, ...update });
    } else if (type === 'alerts') {
      await new Alert(data).save();
      const activity = {
        hotelId: data.hotelId,
        id: Date.now().toString(),
        type: 'security',
        action: `Alert: ${data.alert_message} for ${data.role} in Room ${data.room}`,
        user: 'System',
        time: data.triggered_at
      };
      await new Activity(activity).save();
      broadcastToClients(`activityUpdate:${data.hotelId}`, activity);
    } else if (type === 'denied_access') {
      await new Denied(data).save();
      const activity = {
        hotelId: data.hotelId,
        id: Date.now().toString(),
        type: 'security',
        action: `Denied access to ${data.role}: ${data.denial_reason} for Room ${data.room}`,
        user: data.role,
        time: data.attempted_at
      };
      await new Activity(activity).save();
      broadcastToClients(`activityUpdate:${data.hotelId}`, activity);
    }
  } catch (err) {
    console.error('Error processing MQTT message:', err.message);
  }
}

// Disable Aedes TCP server - not needed for WebSocket-only setup
console.log('🚫 Aedes TCP MQTT broker disabled (using WebSocket only)');

// Disable Aedes publish handler to prevent conflicts
aedes.on('client', (client) => {
  console.log('⚠️ Aedes client connected (should not happen)');
});

/**
 * Handle MQTT messages from ESP32 devices (attendance, power, alerts).
 */
aedes.on('publish', async (packet, client) => {
  if (packet.topic.startsWith('campus/room/')) {
    try {
      const data = JSON.parse(packet.payload.toString());
      const [, , building, floor, roomNum, type] = packet.topic.split('/');
      
      // Validate MQTT data
      if (!floor || !roomNum || !type) {
        console.error('Invalid MQTT topic format:', packet.topic);
        return;
      }
      
      data.room = roomNum;
      data.hotelId = floor; // Map floor to hotelId

      let newActivity = null;

      if (type === 'attendance') {
        const accessType = getAccessType(data.role);
        data.accessType = accessType;
        await new Attendance(data).save();
        console.log(`Saved attendance for room ${roomNum} in hotel ${data.hotelId}:`, data);

        // Update room status with enhanced logic for guest / housekeeping / master
        let update = {};
        let hasMasterKeyUpdate = {};
        let extraRoomFields = {};

        const { minCleaningDurationSeconds } = await getSettingsForHotel(data.hotelId);
        const connectivityUpdate = { lastSeenAt: new Date().toISOString() };

        if (data.check_in) {
          if (accessType === 'guest') {
            update = {
              status: 'occupied',
              occupantType: 'guest',
              powerStatus: 'on',
            };
          } else if (accessType === 'housekeeping') {
            update = {
              status: 'cleaning',
              occupantType: 'housekeeping',
              powerStatus: 'on',
            };
            extraRoomFields = { cleaningStartTime: data.check_in };
          } else if (accessType === 'master') {
            hasMasterKeyUpdate = { hasMasterKey: true };
          } else {
            const status = data.role === 'Maintenance' ? 'maintenance' : 'occupied';
            update = {
              status,
              occupantType: data.role.toLowerCase(),
              powerStatus: 'on',
            };
            if (data.role === 'Manager') {
              hasMasterKeyUpdate = { hasMasterKey: true };
            }
          }
        } else {
          if (accessType === 'guest') {
            update = {
              status: 'dirty',
              occupantType: null,
              powerStatus: 'off',
            };
          } else if (accessType === 'housekeeping') {
            // On cleaner checkout, always mark room as vacant and clear cleaningStartTime
            update = {
              status: 'vacant',
              occupantType: null,
              powerStatus: 'off',
              cleaningStartTime: null,
            };
          } else if (accessType === 'master') {
            hasMasterKeyUpdate = { hasMasterKey: false };
          } else {
            update = {
              status: 'vacant',
              occupantType: null,
              powerStatus: 'off',
            };
            if (data.role === 'Manager') {
              hasMasterKeyUpdate = { hasMasterKey: false };
            }
          }
        }

        const fullUpdate = { ...update, ...hasMasterKeyUpdate, ...extraRoomFields, ...connectivityUpdate };
        if (Object.keys(fullUpdate).length > 0) {
          const updatedRoom = await Room.findOneAndUpdate(
            { hotelId: data.hotelId, number: roomNum },
            fullUpdate,
            { upsert: true, new: true }
          );
          broadcastToClients(`roomUpdate:${data.hotelId}`, { roomNum, ...fullUpdate });
        }

        // Create activity
        const activityType = data.check_in ? 'checkin' : 'checkout';
        let action = `${data.role} checked ${data.check_in ? 'in' : 'out'} to Room ${data.room}`;

        // Add note if cleaning/maintenance duration exceeded threshold
        const roleNormalized = (data.role || '').toLowerCase();
        const isCleaningRole = roleNormalized === 'maintenance' || roleNormalized === 'housekeeping' || roleNormalized === 'cleaner';
        if (!data.check_in && isCleaningRole && typeof data.duration !== 'undefined') {
          const durationSeconds = Number(data.duration) || 0;
          if (durationSeconds >= minCleaningDurationSeconds) {
            const diffSeconds = Math.max(durationSeconds - minCleaningDurationSeconds, 0);
            const exceedMinutes = Math.floor(diffSeconds / 60);
            const exceedSeconds = diffSeconds % 60;
            action += ` (Exceeded cleaning limit by ${exceedMinutes} min ${exceedSeconds} sec)`;
          }
        }

        const time = data.check_in || data.check_out;
        newActivity = {
          hotelId: data.hotelId,
          id: new Date().getTime().toString(),
          type: activityType,
          action,
          user: data.role,
          time,
        };
      } else if (type === 'power') {
        const current = typeof data.current === 'number' ? data.current : Number(data.current || 0);
        const timestamp = data.timestamp || new Date().toISOString();
        try {
          await new PowerLog({
            hotelId: data.hotelId,
            room: roomNum,
            current,
            timestamp,
          }).save();
        } catch (err) {
          console.error('Error saving power log (MQTT):', err);
        }

        const { lowPowerCurrentThreshold } = await getSettingsForHotel(data.hotelId);
        const hasLowPower = current > 0 && current <= lowPowerCurrentThreshold;
        const powerUpdate = {
          hasLowPower,
          lastSeenAt: new Date().toISOString(),
        };

        const updatedRoom = await Room.findOneAndUpdate(
          { hotelId: data.hotelId, number: roomNum },
          powerUpdate,
          { upsert: true, new: true }
        );
        broadcastToClients(`roomUpdate:${data.hotelId}`, { roomNum, ...powerUpdate });
      } else if (type === 'alerts') {
        await new Alert(data).save();
        console.log(`Saved alert for room ${roomNum} in hotel ${data.hotelId}:`, data);

        // Create activity
        const activityType = 'security';
        const action = `Alert: ${data.alert_message} for ${data.role} in Room ${data.room}`;
        const time = data.triggered_at;
        newActivity = {
          hotelId: data.hotelId,
          id: new Date().getTime().toString(),
          type: activityType,
          action,
          user: 'System',
          time,
        };
      } else if (type === 'denied_access') {
        await new Denied(data).save();
        console.log(`Saved denied access for room ${roomNum} in hotel ${data.hotelId}:`, data);

        // Create activity
        const action = `Denied access to ${data.role}: ${data.denial_reason} for Room ${data.room}`;
        const time = data.attempted_at;
        newActivity = {
          hotelId: data.hotelId,
          id: new Date().getTime().toString(),
          type: 'security',
          action,
          user: data.role,
          time,
        };
      }

      if (newActivity) {
        const savedActivity = await new Activity(newActivity).save();
        broadcastToClients(`activityUpdate:${data.hotelId}`, savedActivity);
      }
    } catch (err) {
      console.error('Error processing MQTT message:', err);
    }
  }
});

/**
 * HTTP API endpoints used by the frontend dashboards.
 */
app.get('/api/hotel/:hotelId', validateHotelId, async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ id: req.params.hotelId });
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }
    const rooms = await Room.find({ hotelId: req.params.hotelId });
    const totalRooms = rooms.length;
    const activeRooms = rooms.filter((r) => r.status === 'occupied' || r.status === 'maintenance').length;
    const occupancy = totalRooms ? Math.round((activeRooms / totalRooms) * 100) : 0;
    res.json({ ...hotel.toObject(), totalRooms, activeRooms, occupancy });
  } catch (error) {
    console.error('Error fetching hotel:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/settings/:hotelId', validateHotelId, async (req, res) => {
  try {
    const hotelId = req.params.hotelId;
    const effective = await getSettingsForHotel(hotelId);
    res.json({ hotelId, ...effective });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/settings/:hotelId', validateHotelId, async (req, res) => {
  try {
    const hotelId = req.params.hotelId;
    const { minCleaningDurationSeconds, lowPowerCurrentThreshold } = req.body;

    const update = {};
    if (typeof minCleaningDurationSeconds === 'number') {
      update.minCleaningDurationSeconds = minCleaningDurationSeconds;
    }
    if (typeof lowPowerCurrentThreshold === 'number') {
      update.lowPowerCurrentThreshold = lowPowerCurrentThreshold;
    }

    const settings = await Settings.findOneAndUpdate(
      { hotelId },
      update,
      { new: true, upsert: true }
    );

    const effective = {
      minCleaningDurationSeconds: settings.minCleaningDurationSeconds || MIN_CLEANING_DURATION_SECONDS,
      lowPowerCurrentThreshold: settings.lowPowerCurrentThreshold || LOW_POWER_CURRENT_THRESHOLD,
    };

    res.json({ hotelId, ...effective });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/hotel/:hotelId', validateHotelId, async (req, res) => {
  try {
    await Hotel.findOneAndUpdate({ id: req.params.hotelId }, req.body, { upsert: true });
    res.json({ message: 'Hotel updated successfully' });
  } catch (error) {
    console.error('Error updating hotel:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/hotels', async (req, res) => {
  try {
    const hotels = await Hotel.find();
    const hotelsWithStats = await Promise.all(
      hotels.map(async (hotel) => {
        const rooms = await Room.find({ hotelId: hotel.id });
        const totalRooms = rooms.length;
        const activeRooms = rooms.filter((r) => r.status === 'occupied' || r.status === 'maintenance').length;
        const occupancy = totalRooms ? Math.round((activeRooms / totalRooms) * 100) : 0;
        return { ...hotel.toObject(), totalRooms, activeRooms, occupancy };
      })
    );
    res.json(hotelsWithStats);
  } catch (error) {
    console.error('Error fetching hotels:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/rooms/:hotelId', validateHotelId, async (req, res) => {
  try {
    const rooms = await Room.find({ hotelId: req.params.hotelId }).sort({ number: 1 });
    res.json(rooms);
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/attendance/:hotelId', validateHotelId, async (req, res) => {
  try {
    const data = await Attendance.find({ hotelId: req.params.hotelId }).sort({ createdAt: -1 });
    res.json(data);
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/alerts/:hotelId', validateHotelId, async (req, res) => {
  try {
    const data = await Alert.find({ hotelId: req.params.hotelId }).sort({ createdAt: -1 });
    res.json(data);
  } catch (error) {
    console.error('Error fetching alerts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/denied_access/:hotelId', validateHotelId, async (req, res) => {
  try {
    const data = await Denied.find({ hotelId: req.params.hotelId }).sort({ createdAt: -1 });
    res.json(data);
  } catch (error) {
    console.error('Error fetching denied access:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/users/:hotelId', validateHotelId, async (req, res) => {
  try {
    const data = await User.find({ hotelId: req.params.hotelId });
    res.json(data);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/cards/:hotelId', validateHotelId, async (req, res) => {
  try {
    const data = await Card.find({ hotelId: req.params.hotelId });
    res.json(data);
  } catch (error) {
    console.error('Error fetching cards:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/activity/:hotelId', validateHotelId, async (req, res) => {
  try {
    const data = await Activity.find({ hotelId: req.params.hotelId }).sort({ createdAt: -1 });
    res.json(data);
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/power/:hotelId', validateHotelId, async (req, res) => {
  try {
    const hotelId = req.params.hotelId;

    const latestPerRoom = await PowerLog.aggregate([
      { $match: { hotelId } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$room',
          room: { $first: '$room' },
          hotelId: { $first: '$hotelId' },
          current: { $first: '$current' },
          timestamp: { $first: '$timestamp' },
        },
      },
      {
        $project: {
          _id: 0,
          room: 1,
          hotelId: 1,
          current: 1,
          timestamp: 1,
        },
      },
      { $sort: { room: 1 } },
    ]);

    res.json(latestPerRoom);
  } catch (error) {
    console.error('Error fetching power logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ESP32 Data Handler - Direct HTTP endpoint for ESP32 communication
app.post('/api/mqtt-data', async (req, res) => {
  try {
    const { topic, data } = req.body;
    
    if (!topic || !data) {
      return res.status(400).json({ error: 'Missing topic or data' });
    }

    // Parse topic: campus/room/{building}/{floor}/{roomNum}/{type}
    const topicParts = topic.split('/');
    if (topicParts.length !== 6 || topicParts[0] !== 'campus' || topicParts[1] !== 'room') {
      return res.status(400).json({ error: 'Invalid topic format' });
    }

    const [, , building, floor, roomNum, type] = topicParts;
    
    // Add room and hotelId to data
    const processedData = {
      ...data,
      room: roomNum,
      hotelId: floor
    };

    let newActivity = null;

    if (type === 'attendance') {
      const accessType = getAccessType(processedData.role);
      processedData.accessType = accessType;
      await new Attendance(processedData).save();
      console.log(`Saved attendance for room ${roomNum} in hotel ${processedData.hotelId}:`, processedData);

      // Update room status with enhanced logic for guest / housekeeping / master
      let update = {};
      let hasMasterKeyUpdate = {};
      let extraRoomFields = {};

      const { minCleaningDurationSeconds } = await getSettingsForHotel(processedData.hotelId);
      const connectivityUpdate = { lastSeenAt: new Date().toISOString() };

      if (processedData.check_in) {
        if (accessType === 'guest') {
          update = {
            status: 'occupied',
            occupantType: 'guest',
            powerStatus: 'on',
          };
        } else if (accessType === 'housekeeping') {
          update = {
            status: 'cleaning',
            occupantType: 'housekeeping',
            powerStatus: 'on',
          };
          extraRoomFields = { cleaningStartTime: processedData.check_in };
        } else if (accessType === 'master') {
          hasMasterKeyUpdate = { hasMasterKey: true };
        } else {
          const status = processedData.role === 'Maintenance' ? 'maintenance' : 'occupied';
          update = {
            status,
            occupantType: processedData.role.toLowerCase(),
            powerStatus: 'on',
          };
          if (processedData.role === 'Manager') {
            hasMasterKeyUpdate = { hasMasterKey: true };
          }
        }
      } else {
        if (accessType === 'guest') {
          update = {
            status: 'dirty',
            occupantType: null,
            powerStatus: 'off',
          };
        } else if (accessType === 'housekeeping') {
          // On cleaner checkout, always mark room as vacant and clear cleaningStartTime
          update = {
            status: 'vacant',
            occupantType: null,
            powerStatus: 'off',
            cleaningStartTime: null,
          };
        } else if (accessType === 'master') {
          hasMasterKeyUpdate = { hasMasterKey: false };
        } else {
          update = {
            status: 'vacant',
            occupantType: null,
            powerStatus: 'off',
          };
          if (processedData.role === 'Manager') {
            hasMasterKeyUpdate = { hasMasterKey: false };
          }
        }
      }

      const fullUpdate = { ...update, ...hasMasterKeyUpdate, ...extraRoomFields, ...connectivityUpdate };
      if (Object.keys(fullUpdate).length > 0) {
        await Room.findOneAndUpdate(
          { hotelId: processedData.hotelId, number: roomNum },
          fullUpdate,
          { upsert: true, new: true }
        );
        broadcastToClients(`roomUpdate:${processedData.hotelId}`, { roomNum, ...fullUpdate });
      }

      // Create activity
      const activityType = processedData.check_in ? 'checkin' : 'checkout';
      let action = `${processedData.role} checked ${processedData.check_in ? 'in' : 'out'} to Room ${processedData.room}`;

      // Add note if cleaning/maintenance duration exceeded threshold
      const roleNormalized = (processedData.role || '').toLowerCase();
      const isCleaningRole = roleNormalized === 'maintenance' || roleNormalized === 'housekeeping' || roleNormalized === 'cleaner';
      if (!processedData.check_in && isCleaningRole && typeof processedData.duration !== 'undefined') {
        const durationSeconds = Number(processedData.duration) || 0;
        console.log('Cleaning duration debug (HTTP attendance)', {
          hotelId: processedData.hotelId,
          room: processedData.room,
          role: processedData.role,
          accessType,
          isCleaningRole,
          durationRaw: processedData.duration,
          durationSeconds,
          minCleaningDurationSeconds,
          check_in: processedData.check_in,
          check_out: processedData.check_out,
        });
        if (durationSeconds >= minCleaningDurationSeconds) {
          const diffSeconds = Math.max(durationSeconds - minCleaningDurationSeconds, 0);
          const exceedMinutes = Math.floor(diffSeconds / 60);
          const exceedSeconds = diffSeconds % 60;
          action += ` (Exceeded cleaning limit by ${exceedMinutes} min ${exceedSeconds} sec)`;
        }
      }

      const time = processedData.check_in || processedData.check_out;
      newActivity = {
        hotelId: processedData.hotelId,
        id: new Date().getTime().toString(),
        type: activityType,
        action,
        user: processedData.role,
        time,
      };
    } else if (type === 'power') {
      const current = typeof processedData.current === 'number'
        ? processedData.current
        : Number(processedData.current || 0);
      const timestamp = processedData.timestamp || new Date().toISOString();

      try {
        await new PowerLog({
          hotelId: processedData.hotelId,
          room: roomNum,
          current,
          timestamp,
        }).save();
      } catch (err) {
        console.error('Error saving power log (HTTP):', err);
      }

      const { lowPowerCurrentThreshold } = await getSettingsForHotel(processedData.hotelId);
      const hasLowPower = current > 0 && current <= lowPowerCurrentThreshold;
      const powerUpdate = {
        hasLowPower,
        lastSeenAt: new Date().toISOString(),
      };

      await Room.findOneAndUpdate(
        { hotelId: processedData.hotelId, number: roomNum },
        powerUpdate,
        { upsert: true, new: true }
      );

      broadcastToClients(`roomUpdate:${processedData.hotelId}`, { roomNum, ...powerUpdate });
    } else if (type === 'alerts') {
      await new Alert(processedData).save();
      console.log(`Saved alert for room ${roomNum} in hotel ${processedData.hotelId}:`, processedData);

      // Create activity
      const activityType = 'security';
      const action = `Alert: ${processedData.alert_message} for ${processedData.role} in Room ${processedData.room}`;
      const time = processedData.triggered_at;
      newActivity = {
        hotelId: processedData.hotelId,
        id: new Date().getTime().toString(),
        type: activityType,
        action,
        user: 'System',
        time,
      };
    } else if (type === 'denied_access') {
      await new Denied(processedData).save();
      console.log(`Saved denied access for room ${roomNum} in hotel ${processedData.hotelId}:`, processedData);

      // Create activity
      const action = `Denied access to ${processedData.role}: ${processedData.denial_reason} for Room ${processedData.room}`;
      const time = processedData.attempted_at;
      newActivity = {
        hotelId: processedData.hotelId,
        id: new Date().getTime().toString(),
        type: 'security',
        action,
        user: processedData.role,
        time,
      };
    }

    if (newActivity) {
      const savedActivity = await new Activity(newActivity).save();
      broadcastToClients(`activityUpdate:${processedData.hotelId}`, savedActivity);
    }

    res.json({ success: true, message: 'Data processed successfully' });
  } catch (error) {
    console.error('Error processing ESP32 data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Fallback MQTT simulation endpoint
app.post('/api/simulate-mqtt', async (req, res) => {
  try {
    const { topic, payload } = req.body;
    
    if (!topic || !payload) {
      return res.status(400).json({ error: 'Missing topic or payload' });
    }

    // Parse the payload as JSON
    let data;
    try {
      data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    // Simulate the MQTT message processing
    const topicParts = topic.split('/');
    if (topicParts.length >= 6) {
      const [, , building, floor, roomNum, type] = topicParts;
      
      data.room = roomNum;
      data.hotelId = floor;

      let newActivity = null;

      if (type === 'attendance') {
        const accessType = getAccessType(data.role);
        data.accessType = accessType;
        await new Attendance(data).save();
        console.log(`Simulated MQTT - Saved attendance for room ${roomNum}:`, data);
        
        // Update room status (same logic as MQTT handler)
        let update = {};
        let hasMasterKeyUpdate = {};
        let extraRoomFields = {};

        const connectivityUpdate = { lastSeenAt: new Date().toISOString() };

        if (data.check_in) {
          if (accessType === 'guest') {
            update = {
              status: 'occupied',
              occupantType: 'guest',
              powerStatus: 'on',
            };
          } else if (accessType === 'housekeeping') {
            update = {
              status: 'cleaning',
              occupantType: 'housekeeping',
              powerStatus: 'on',
            };
            extraRoomFields = { cleaningStartTime: data.check_in };
          } else if (accessType === 'master') {
            hasMasterKeyUpdate = { hasMasterKey: true };
          } else {
            const status = data.role === 'Maintenance' ? 'maintenance' : 'occupied';
            update = {
              status,
              occupantType: data.role.toLowerCase(),
              powerStatus: 'on',
            };
            if (data.role === 'Manager') {
              hasMasterKeyUpdate = { hasMasterKey: true };
            }
          }
        } else {
          if (accessType === 'guest') {
            update = {
              status: 'dirty',
              occupantType: null,
              powerStatus: 'off',
            };
          } else if (accessType === 'housekeeping') {
            update = {
              status: 'vacant',
              occupantType: null,
              powerStatus: 'off',
              cleaningStartTime: null,
            };
          } else if (accessType === 'master') {
            hasMasterKeyUpdate = { hasMasterKey: false };
          } else {
            update = {
              status: 'vacant',
              occupantType: null,
              powerStatus: 'off',
            };
            if (data.role === 'Manager') {
              hasMasterKeyUpdate = { hasMasterKey: false };
            }
          }
        }
        
        const fullUpdate = { ...update, ...hasMasterKeyUpdate, ...extraRoomFields, ...connectivityUpdate };
        if (Object.keys(fullUpdate).length > 0) {
          await Room.findOneAndUpdate(
            { hotelId: data.hotelId, number: roomNum },
            fullUpdate,
            { upsert: true, new: true }
          );
          broadcastToClients(`roomUpdate:${data.hotelId}`, { roomNum, ...fullUpdate });
        }

        const activityType = data.check_in ? 'checkin' : 'checkout';
        const action = `${data.role} checked ${data.check_in ? 'in' : 'out'} to Room ${data.room}`;
        const time = data.check_in || data.check_out;
        newActivity = {
          hotelId: data.hotelId,
          id: new Date().getTime().toString(),
          type: activityType,
          action,
          user: data.role,
          time,
        };
      } else if (type === 'alerts') {
        await new Alert(data).save();
        console.log(`Simulated MQTT - Saved alert for room ${roomNum}:`, data);
        
        newActivity = {
          hotelId: data.hotelId,
          id: new Date().getTime().toString(),
          type: 'security',
          action: `Alert: ${data.alert_message} for ${data.role} in Room ${data.room}`,
          user: 'System',
          time: data.triggered_at,
        };
      } else if (type === 'denied_access') {
        await new Denied(data).save();
        console.log(`Simulated MQTT - Saved denied access for room ${roomNum}:`, data);
        
        newActivity = {
          hotelId: data.hotelId,
          id: new Date().getTime().toString(),
          type: 'security',
          action: `Denied access to ${data.role}: ${data.denial_reason} for Room ${data.room}`,
          user: data.role,
          time: data.attempted_at,
        };
      }

      if (newActivity) {
        const savedActivity = await new Activity(newActivity).save();
        broadcastToClients(`activityUpdate:${data.hotelId}`, savedActivity);
      }
    }

    res.json({ success: true, message: 'MQTT simulation processed successfully' });
  } catch (error) {
    console.error('Error in MQTT simulation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check route for external uptime checks
app.get('/health', (req, res) => res.json({ 
  status: 'ok',
  mqtt_websocket: 'enabled',
  tcp_mqtt: process.env.NODE_ENV !== 'production' ? 'enabled' : 'disabled'
}));

// Graceful shutdown for Render / production environments
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    mongoose.connection.close();
    process.exit(0);
  });
});

server.listen(httpPort, () => {
  const host = process.env.RENDER_EXTERNAL_URL || `http://0.0.0.0:${httpPort}`;
  const wsUrl = host.startsWith('https://')
    ? host.replace(/^https/, 'wss') + '/mqtt'
    : host.replace(/^http/, 'ws') + '/mqtt';

  console.log(`🚀 HTTP/WebSocket server running on port ${httpPort}`);
  console.log(`📡 MQTT over WebSocket: ${wsUrl}`);
  console.log(`🌐 API endpoints available at ${host}/api`);
});
