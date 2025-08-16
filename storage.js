const fs = require('fs').promises;
const path = require('path');

const dataDir = process.env.DATA_DIR || './data';
const usersPath = path.join(dataDir, 'users.json');
const threadsPath = path.join(dataDir, 'threads.json');

async function initStorage() {
    try {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.access(usersPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.writeFile(usersPath, '[]', 'utf-8');
        }
    }

    try {
        await fs.access(threadsPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.writeFile(threadsPath, '[]', 'utf-8');
        }
    }
}

async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function writeJsonFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function upsertUser(user) {
    const users = await readJsonFile(usersPath);
    const userIndex = users.findIndex(u => u.user_id === user.id);

    if (userIndex !== -1) {
        users[userIndex] = {
            ...users[userIndex],
            first_name: user.first_name,
            last_name: user.last_name,
            username: user.username,
            updated_at: new Date().toISOString(),
        };
    } else {
        users.push({
            user_id: user.id,
            first_name: user.first_name,
            last_name: user.last_name,
            username: user.username,
            updated_at: new Date().toISOString(),
        });
    }

    await writeJsonFile(usersPath, users);
}

async function getThreadByUser(userId) {
    const threads = await readJsonFile(threadsPath);
    return threads.find(t => t.user_id === userId);
}

async function getThreadById(threadId) {
    const threads = await readJsonFile(threadsPath);
    return threads.find(t => t.thread_id === threadId);
}

async function saveThread(threadRecord) {
    const threads = await readJsonFile(threadsPath);
    const threadIndex = threads.findIndex(t => t.thread_id === threadRecord.thread_id);

    if (threadIndex !== -1) {
        threads[threadIndex] = { ...threads[threadIndex], ...threadRecord, updated_at: new Date().toISOString() };
    } else {
        threads.push({ ...threadRecord, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    }

    await writeJsonFile(threadsPath, threads);
}

module.exports = {
    initStorage,
    upsertUser,
    getThreadByUser,
    getThreadById,
    saveThread,
};