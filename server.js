const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Store connected users and chat rooms
const users = new Map();
const chatRooms = new Map();

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: function (req, file, cb) {
        // Allow all file types but check for dangerous ones
        const allowedTypes = /jpeg|jpg|png|gif|pdf|txt|doc|docx|xls|xlsx|ppt|pptx|mp4|mp3|zip|rar/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('File type not allowed'));
        }
    }
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// Default route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// File upload route
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const fileInfo = {
        filename: req.file.filename,
        originalname: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
        url: `/uploads/${req.file.filename}`
    };
    
    res.json(fileInfo);
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Handle user joining with username
    socket.on('join', (data) => {
        const { username, room } = data;
        
        // Store user information
        users.set(socket.id, {
            username: username,
            room: room,
            joinTime: new Date()
        });

        // Join the specified room
        socket.join(room);

        // Initialize room if it doesn't exist
        if (!chatRooms.has(room)) {
            chatRooms.set(room, {
                users: new Set(),
                messages: []
            });
        }

        // Add user to room
        chatRooms.get(room).users.add(socket.id);

        // Notify room that user joined
        const joinMessage = {
            type: 'system',
            message: `${username} joined the chat`,
            timestamp: new Date().toISOString(),
            room: room
        };

        socket.to(room).emit('message', joinMessage);

        // Send welcome message to the user
        const welcomeMessage = {
            type: 'system',
            message: `Welcome to ${room}, ${username}!`,
            timestamp: new Date().toISOString(),
            room: room
        };

        socket.emit('message', welcomeMessage);

        // Update user list for the room
        updateUserList(room);

        // Send recent messages to the new user
        const roomData = chatRooms.get(room);
        if (roomData.messages.length > 0) {
            const recentMessages = roomData.messages.slice(-10); // Send last 10 messages
            socket.emit('recent_messages', recentMessages);
        }
    });

    // Handle chat messages
    socket.on('chat_message', (data) => {
        const user = users.get(socket.id);
        if (user) {
            const messageData = {
                type: 'user',
                username: user.username,
                message: data.message,
                timestamp: new Date().toISOString(),
                room: user.room,
                userId: socket.id,
                file: data.file || null // Add file data if present
            };

            // Store message in room history
            const roomData = chatRooms.get(user.room);
            if (roomData) {
                roomData.messages.push(messageData);
                
                // Keep only last 100 messages per room
                if (roomData.messages.length > 100) {
                    roomData.messages = roomData.messages.slice(-100);
                }
            }

            // Broadcast message to all users in the room
            io.to(user.room).emit('message', messageData);
        }
    });

    // Handle typing indicator
    socket.on('typing', (data) => {
        const user = users.get(socket.id);
        if (user) {
            socket.to(user.room).emit('user_typing', {
                username: user.username,
                isTyping: data.isTyping
            });
        }
    });

    // Handle user disconnect
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        
        const user = users.get(socket.id);
        if (user) {
            // Remove user from room
            const roomData = chatRooms.get(user.room);
            if (roomData) {
                roomData.users.delete(socket.id);
                
                // Notify room that user left
                const leaveMessage = {
                    type: 'system',
                    message: `${user.username} left the chat`,
                    timestamp: new Date().toISOString(),
                    room: user.room
                };

                socket.to(user.room).emit('message', leaveMessage);

                // Update user list for the room
                updateUserList(user.room);

                // Clean up empty rooms
                if (roomData.users.size === 0) {
                    chatRooms.delete(user.room);
                }
            }
        }

        // Remove user from users map
        users.delete(socket.id);
    });

    // Handle request for user list
    socket.on('get_users', () => {
        const user = users.get(socket.id);
        if (user) {
            updateUserList(user.room);
        }
    });

    // Handle room list request
    socket.on('get_rooms', () => {
        const rooms = Array.from(chatRooms.keys()).map(room => ({
            name: room,
            userCount: chatRooms.get(room).users.size
        }));
        socket.emit('room_list', rooms);
    });
});

// Helper function to update user list for a room
function updateUserList(room) {
    const roomData = chatRooms.get(room);
    if (roomData) {
        const userList = Array.from(roomData.users).map(userId => {
            const user = users.get(userId);
            return user ? {
                id: userId,
                username: user.username,
                joinTime: user.joinTime
            } : null;
        }).filter(user => user !== null);

        io.to(room).emit('user_list', userList);
    }
}

// Start server
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Bind to all network interfaces

server.listen(PORT, HOST, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Local access: http://localhost:${PORT}`);
    console.log(`Network access: http://192.168.31.47:${PORT}`);
    console.log(`Share this network URL with your friends!`);
});

// Handle invite link generation
app.get('/invite/:room', (req, res) => {
    const { room } = req.params;
    if (chatRooms.has(room)) {
        // Use the request host to generate the invite link
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers.host || `localhost:${PORT}`;
        const inviteLink = `${protocol}://${host}/?room=${encodeURIComponent(room)}`;
        res.json({ inviteLink });
    } else {
        res.status(404).json({ error: 'Room not found' });
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    server.close(() => {
        console.log('Server stopped');
        process.exit(0);
    });
});
