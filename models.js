const mongoose = require('mongoose');

// Schemas (your exact schemas)
const hotelSchema = new mongoose.Schema({
  id: String,
  name: String,
  location: String,
  address: String,
  phone: String,
  email: String,
  rating: Number,
  description: String,
  image: String,
  status: String,
  lastActivity: String,
  manager: {
    name: String,
    phone: String,
    email: String,
    status: String,
  },
}, { timestamps: true });

const roomSchema = new mongoose.Schema({
  hotelId: String,
  id: Number,
  number: String,
  status: String,
  hasMasterKey: Boolean,
  hasLowPower: Boolean,
  powerStatus: String,
  occupantType: String,
  cleaningStartTime: String,
  lastSeenAt: String,
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  hotelId: String,
  card_uid: String,
  role: String,
  check_in: String,
  check_out: String,
  duration: Number,
  room: String,
  accessType: String,
}, { timestamps: true });

const alertSchema = new mongoose.Schema({
  hotelId: String,
  card_uid: String,
  role: String,
  alert_message: String,
  triggered_at: String,
  room: String,
}, { timestamps: true });

const deniedSchema = new mongoose.Schema({
  hotelId: String,
  card_uid: String,
  role: String,
  denial_reason: String,
  attempted_at: String,
  room: String,
}, { timestamps: true });

const userSchema = new mongoose.Schema({
  hotelId: String,
  id: String,
  name: String,
  email: String,
  role: String,
  status: String,
  lastLogin: String,
  avatar: String,
}, { timestamps: true });

const cardSchema = new mongoose.Schema({
  hotelId: String,
  id: String,
  roomNumber: String,
  guestName: String,
  status: String,
  expiryDate: String,
  lastUsed: String,
}, { timestamps: true });

const activitySchema = new mongoose.Schema({
  hotelId: String,
  id: String,
  type: String,
  action: String,
  user: String,
  time: String,
}, { timestamps: true });

const powerLogSchema = new mongoose.Schema({
  hotelId: String,
  room: String,
  current: Number,
  timestamp: String,
}, { timestamps: true });

const settingsSchema = new mongoose.Schema({
  hotelId: String,
  minCleaningDurationSeconds: Number,
  lowPowerCurrentThreshold: Number,
}, { timestamps: true });

// Indexes for production performance
attendanceSchema.index({ hotelId: 1, room: 1, createdAt: -1 });
powerLogSchema.index({ hotelId: 1, room: 1, createdAt: -1 });

const Hotel = mongoose.model('Hotel', hotelSchema);
const Room = mongoose.model('Room', roomSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const Alert = mongoose.model('Alert', alertSchema);
const Denied = mongoose.model('Denied', deniedSchema);
const User = mongoose.model('User', userSchema);
const Card = mongoose.model('Card', cardSchema);
const Activity = mongoose.model('Activity', activitySchema);
const PowerLog = mongoose.model('PowerLog', powerLogSchema);
const Settings = mongoose.model('Settings', settingsSchema);

module.exports = {
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
};