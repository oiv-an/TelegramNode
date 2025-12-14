import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import dotenv from 'dotenv';
import fs from 'fs';
import express from 'express';
import readline from 'readline';
import FormData from 'form-data';

dotenv.config();

// Configuration
const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const phoneNumber = process.env.TELEGRAM_PHONE_NUMBER;
const sessionFile = 'session.json';
const SERVER_PORT = process.env.SERVER_PORT || 3000;
const API_KEY = process.env.API_SECRET || 'changeme_please';

// Webhook URLs
const WEBHOOK_PROD = process.env.WEBHOOK_PROD || 'https://n8n.example.com/webhook/your-webhook-id';
const WEBHOOK_TEST = process.env.WEBHOOK_TEST || 'https://n8n.example.com/webhook-test/your-webhook-id';

const bigIntReplacer = (key, value) => typeof value === 'bigint' ? value.toString() : value;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askQuestion = (q) => new Promise((resolve) => rl.question(q, resolve));

let client;
let startTime = Date.now();

// Function to send data to n8n webhook
// Always uses FormData to ensure consistent data structure in n8n
async function sendToN8N(payload, fileBuffer = null, fileName = 'file.bin') {
    let headers = { 'x-api-key': API_KEY };
    
    try {
        // Always use FormData, even without files
        // This ensures consistent data structure in n8n (field "data")
        const form = new global.FormData();
        
        // 1. Always put metadata in 'data' field as string
        form.append('data', JSON.stringify(payload, bigIntReplacer)); 
        
        // 2. Add file if present
        if (fileBuffer) {
            const fileBlob = new global.Blob([fileBuffer]);
            form.append('file', fileBlob, fileName);
        }

        // Send request (Content-Type will be set automatically as multipart/form-data)
        const response = await fetch(WEBHOOK_PROD, { method: 'POST', headers, body: form });
        
        if (!response.ok) throw new Error(`Status ${response.status}`);
        
    } catch (errProd) {
        console.warn(`⚠️ Prod Webhook Failed: ${errProd.message}. Trying Test...`);
        // Fallback logic
        try {
            // Rebuild form for test (body stream may already be consumed)
            const formTest = new global.FormData();
            formTest.append('data', JSON.stringify(payload, bigIntReplacer));
            if (fileBuffer) {
                formTest.append('file', new global.Blob([fileBuffer]), fileName);
            }

            const responseTest = await fetch(WEBHOOK_TEST, { method: 'POST', headers, body: formTest });
            if (!responseTest.ok) throw new Error(`Status ${responseTest.status}`);
            console.log('✅ Sent to N8N (Test fallback)');
        } catch (errTest) {
            console.error(`❌ Failed to send to N8N: ${errTest.message}`);
        }
    }
}

async function main() {
    console.log('🚀 Initializing TelegramNode: Telegram Bridge for n8n...');

    // Initialize Telegram Client
    const stringSession = new StringSession(fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf-8') : '');
    client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

    await client.start({
        phoneNumber: async () => phoneNumber,
        password: async () => process.env.TELEGRAM_PASSWORD || await askQuestion('🔑 2FA Password: '),
        phoneCode: async () => await askQuestion('📱 Telegram Code: '),
        onError: (err) => console.log(err),
    });

    console.log('✅ Telegram client connected');
    console.log('🔄 Syncing dialogs...');
    await client.getDialogs({ limit: 100 });
    fs.writeFileSync(sessionFile, client.session.save());
    console.log('✅ Dialogs synced');

    // Initialize Event Handler
    // Album buffer to group messages from the same album
    const albumBucket = new Map(); // structure: groupId -> { timer, msgs: [] }

    // Add event handler for new messages
    client.addEventHandler(async (event) => {
        const msg = event.message;
        if (!msg) return;

        // Check if message is part of an album (has groupedId)
        if (msg.groupedId) {
            const groupId = msg.groupedId.toString();
            
            // Create new group if it doesn't exist
            if (!albumBucket.has(groupId)) {
                albumBucket.set(groupId, { 
                    msgs: [], 
                    timer: null 
                });
            }

            const group = albumBucket.get(groupId);
            
            // Add message to the group
            group.msgs.push(msg);
            
            // Reset timer (Debounce)
            if (group.timer) clearTimeout(group.timer);

            // Set timer to send batch after 2 seconds of silence
            group.timer = setTimeout(async () => {
                await processAlbum(groupId, group.msgs);
                albumBucket.delete(groupId); // Clean up memory
            }, 2000); // 2 секунды задержка чтобы собрать все фото

            return; // Wait for other messages in the album
        }

        // If it's a single message - process immediately
        await processSingleMessage(msg);

    }, new NewMessage({}));

    // --- HELPER FUNCTIONS ---

    // Process single message logic
    async function processSingleMessage(msg, overrideText = null) {
        // Prepare data
        const chatId = msg.peerId ? (msg.peerId.channelId ? `-100${msg.peerId.channelId}` : msg.chatId?.toString()) : null;
        let mediaType = 'text';
        if (msg.photo) mediaType = 'photo';
        else if (msg.voice) mediaType = 'voice';

        let chatTitle = 'Private'; // Simplified title retrieval for performance
        const isProtected = !!(msg.noforwards || (msg.chat && msg.chat.noforwards));

        // Use overrideText if provided (for albums)
        const finalText = overrideText !== null ? overrideText : (msg.message || '');

        const payload = {
            event_date: new Date(msg.date * 1000).toISOString(),
            timestamp: msg.date,
            chat_id: chatId,
            chat_title: chatTitle,
            message_id: msg.id,
            text: finalText,
            media_type: mediaType,
            is_protected: isProtected,
            is_album: !!msg.groupedId // Flag indicating this is part of an album
        };

        // Download logic for protected content
        if (isProtected && (msg.photo || msg.voice)) {
            console.log(`🔒 Protected ${mediaType} detected. Downloading...`);
            try {
                const buffer = await client.downloadMedia(msg, { workers: 1 });
                if (buffer) {
                    const ext = msg.voice ? 'ogg' : 'jpg';
                    const fname = `protected_${msg.id}.${ext}`;
                    await sendToN8N(payload, buffer, fname);
                    return;
                }
            } catch (err) {
                console.error('❌ Download Error:', err.message);
                payload.error = err.message;
            }
        }
        
        await sendToN8N(payload);
    }

    // Process album batch logic
    async function processAlbum(groupId, messages) {
        console.log(`📦 Processing Album ${groupId}: ${messages.length} items`);
        
        // 1. Sort by ID to send in order
        messages.sort((a, b) => a.id - b.id);

        // 2. Find text (usually only in one message)
        const fullText = messages.find(m => m.message && m.message.length > 0)?.message || '';

        // 3. Process all messages in the album
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const isLast = (i === messages.length - 1);
            
            // TEXT LOGIC:
            // If last message -> include full text
            // If not last -> include empty text (or could use truncated text)
            const textToSend = isLast ? fullText : ''; 

            console.log(`  -> Processing album part ${i + 1}/${messages.length} (Has Text: ${!!textToSend})`);
            
            // Send through common function
            await processSingleMessage(msg, textToSend);
        }
    }

    // Initialize API Server
    const app = express();
    app.use(express.json());

    app.use((req, res, next) => {
        if (req.headers['x-api-key'] !== API_KEY) return res.status(403).json({ error: 'Access Denied' });
        next();
    });

    app.get('/health', (req, res) => {
        res.json({ status: 'online', mode: 'protected_bridge', uptime: (Date.now() - startTime) / 1000 });
    });

    app.post('/forward', async (req, res) => {
        try {
            let { fromChatId, messageIds, toChatId } = req.body;
            if (!fromChatId || !messageIds || !toChatId) return res.status(400).json({ error: 'Missing params' });

            const resolveInput = (input) => (typeof input === 'string' && isNaN(input)) ? input : BigInt(input);
            const fromPeer = await client.getEntity(resolveInput(fromChatId));
            const toPeer = await client.getEntity(resolveInput(toChatId));

            const result = await client.forwardMessages(toPeer, { messages: messageIds, fromPeer: fromPeer });
            res.json({ success: true, forwarded_count: result.length });
        } catch (error) {
            console.error('API Forward Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.listen(SERVER_PORT, '0.0.0.0', () => {
        console.log(`🌍 Bridge Server listening on port ${SERVER_PORT}`);
    });
}

main();