const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const DB_CLIENT = (process.env.DB_CLIENT || 'sqlite').toLowerCase();
const USING_POSTGRES = DB_CLIENT === 'postgres';
let pool = null;
let db;
let dbFilePath = null;

let runAsync;
let getAsync;
let allAsync;

if (USING_POSTGRES) {
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL environment variable is required when DB_CLIENT=postgres.');
        process.exit(1);
    }
    const { Pool } = require('pg');
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    const prepareQuery = (sql) => {
        let index = 0;
        return sql.replace(/\?/g, () => {
            index += 1;
            return `$${index}`;
        });
    };

    db = {
        run(sql, params, callback) {
            if (typeof params === 'function') {
                callback = params;
                params = [];
            }
            const prepared = prepareQuery(sql);
            const promise = pool.query(prepared, params || []);
            if (callback) {
                promise
                    .then((result) => {
                        const context = {
                            lastID: result.rows && result.rows[0] && result.rows[0].id !== undefined ? result.rows[0].id : null,
                            changes: result.rowCount
                        };
                        callback.call(context, null, result);
                    })
                    .catch((err) => callback(err));
            }
            return promise;
        },
        get(sql, params, callback) {
            if (typeof params === 'function') {
                callback = params;
                params = [];
            }
            const prepared = prepareQuery(sql);
            const promise = pool
                .query(prepared, params || [])
                .then((result) => result.rows[0] || null);
            if (callback) {
                promise.then((row) => callback(null, row)).catch((err) => callback(err));
            }
            return promise;
        },
        all(sql, params, callback) {
            if (typeof params === 'function') {
                callback = params;
                params = [];
            }
            const prepared = prepareQuery(sql);
            const promise = pool
                .query(prepared, params || [])
                .then((result) => result.rows || []);
            if (callback) {
                promise.then((rows) => callback(null, rows)).catch((err) => callback(err));
            }
            return promise;
        },
        prepare(sql) {
            const prepared = prepareQuery(sql);
            return {
                run(params, callback) {
                    if (typeof params === 'function') {
                        callback = params;
                        params = [];
                    }
                    const promise = pool.query(prepared, params || []);
                    if (callback) {
                        promise.then(() => callback(null)).catch((err) => callback(err));
                    }
                    return promise;
                },
                finalize(callback) {
                    if (callback) callback(null);
                }
            };
        },
        serialize(callback) {
            callback();
        }
    };

    runAsync = (sql, params = []) => pool.query(prepareQuery(sql), params);
    getAsync = (sql, params = []) =>
        pool.query(prepareQuery(sql), params).then((result) => result.rows[0] || null);
    allAsync = (sql, params = []) =>
        pool.query(prepareQuery(sql), params).then((result) => result.rows || []);
} else {
    const sqlite3 = require('sqlite3').verbose();
    dbFilePath = path.join(__dirname, 'students.db');
    db = new sqlite3.Database(dbFilePath, (err) => {
        if (err) {
            console.error('Failed to open SQLite database:', err);
            process.exit(1);
        }
    });
    db.run('PRAGMA foreign_keys = ON;');

    runAsync = (sql, params = []) =>
        new Promise((resolve, reject) => {
            db.run(sql, params, function (err) {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(this);
            });
        });

    getAsync = (sql, params = []) =>
        new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(row || null);
            });
        });

    allAsync = (sql, params = []) =>
        new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(rows || []);
            });
        });
}

const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const STORAGE_PROVIDER = (process.env.STORAGE_PROVIDER || (IMGBB_API_KEY ? 'imgbb' : 'local')).toLowerCase();
const USE_IMGBB = STORAGE_PROVIDER === 'imgbb';
const USE_R2 = STORAGE_PROVIDER === 'r2';
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID?.trim();
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID?.trim();
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY?.trim();
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME?.trim();
const R2_BUCKET_PREFIX = (process.env.R2_BUCKET_PREFIX || 'photos/').trim();
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || (R2_ACCOUNT_ID && R2_BUCKET_NAME ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}` : null))?.trim();

let r2Client = null;
if (USE_IMGBB) {
    console.log('ImgBB storage enabled for student photos.');
} else if (USE_R2) {
    const missing = [];
    if (!R2_ACCOUNT_ID) missing.push('R2_ACCOUNT_ID');
    if (!R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
    if (!R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
    if (!R2_BUCKET_NAME) missing.push('R2_BUCKET_NAME');
    if (missing.length) {
        console.error(`Missing Cloudflare R2 configuration: ${missing.join(', ')}`);
        process.exit(1);
    }
    const r2Endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    console.log('[R2 Config] Initializing R2 client:', {
        endpoint: r2Endpoint,
        accountId: R2_ACCOUNT_ID,
        bucketName: R2_BUCKET_NAME,
        hasAccessKey: !!R2_ACCESS_KEY_ID,
        hasSecretKey: !!R2_SECRET_ACCESS_KEY,
        accessKeyLength: R2_ACCESS_KEY_ID?.length,
        secretKeyLength: R2_SECRET_ACCESS_KEY?.length
    });
    r2Client = new S3Client({
        region: 'auto',
        endpoint: r2Endpoint,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY
        },
        forcePathStyle: true,
        tls: true
    });
    console.log('Cloudflare R2 storage enabled for student photos.');
} else {
    console.warn('No external storage configured; using local disk storage for photos.');
}

const DEFAULT_PHOTO_URL = process.env.DEFAULT_PHOTO_URL || 'https://via.placeholder.com/150?text=Student';

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.static('public', { index: false })); // Don't serve index.html for all routes
app.use('/uploads', express.static('uploads'));
app.use('/assets', express.static('assets'));

// Debug: Log all PUT requests (AFTER body parser, BEFORE routes)
app.use((req, res, next) => {
    if (req.method === 'PUT') {
        console.log(`[DEBUG PUT] Method: ${req.method}, Path: ${req.path}, OriginalUrl: ${req.originalUrl}`);
        console.log(`[DEBUG PUT] Headers:`, req.headers);
        console.log(`[DEBUG PUT] Body available:`, !!req.body);
        if (req.body) {
            console.log(`[DEBUG PUT] Body keys:`, Object.keys(req.body));
        }
    }
    next();
});

// Ensure directories exist
const uploadsDir = path.join(__dirname, 'uploads', 'photos');
const assetsDir = path.join(__dirname, 'public', 'assets');
if (!USE_IMGBB && !USE_R2 && !fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

// Configure multer for file uploads
const diskStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname || ''));
    }
});

const upload = multer({ 
    storage: (USE_IMGBB || USE_R2) ? multer.memoryStorage() : diskStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

async function uploadPhotoToImgBB(file) {
    if (!USE_IMGBB || !file?.buffer) throw new Error('ImgBB not configured or invalid file buffer.');
    const form = new FormData();
    form.append('image', file.buffer.toString('base64'));
    if (file.originalname) {
        const cleanedName = path.parse(file.originalname).name.slice(0, 75);
        if (cleanedName) form.append('name', cleanedName);
    }

    const response = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });

    if (!response.data?.data?.url) {
        const errMsg = response.data?.error?.message || 'Unknown error';
        throw new Error(`ImgBB upload failed: ${errMsg}`);
    }

    return {
        url: response.data.data.url,
        deleteUrl: response.data.data.delete_url || null
    };
}

async function deletePhotoFromImgBB(deleteUrl) {
    if (!USE_IMGBB || !deleteUrl) return;
    try {
        await axios.get(deleteUrl);
    } catch (err) {
        console.warn(`Failed to delete ImgBB image: ${err.message}`);
    }
}

async function uploadPhotoToR2(file) {
    if (!USE_R2 || !file?.buffer) throw new Error('R2 not configured or invalid file buffer.');
    const extension = path.extname(file.originalname || '') || '.jpg';
    const uniqueKey = `${R2_BUCKET_PREFIX}${Date.now()}-${crypto.randomUUID()}${extension}`;
    const contentType = file.mimetype || 'application/octet-stream';
    console.log('[R2 Upload] Attempting upload:', {
        bucket: R2_BUCKET_NAME,
        key: uniqueKey,
        contentType: contentType,
        bufferSize: file.buffer.length,
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
    });
    await r2Client.send(new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: uniqueKey,
        Body: file.buffer,
        ContentType: contentType
    }));
    console.log('[R2 Upload] Success!');
    const baseUrl = (R2_PUBLIC_BASE_URL || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}`).replace(/\/$/, '');
    const photoUrl = `${baseUrl}/${uniqueKey}`;
    console.log('[R2 Upload] Generated URL:', photoUrl);
    console.log('[R2 Upload] Base URL:', baseUrl);
    console.log('[R2 Upload] Key:', uniqueKey);
    return {
        url: photoUrl,
        deleteKey: uniqueKey
    };
}

async function deletePhotoFromR2(deleteKey) {
    if (!USE_R2 || !deleteKey) return;
    try {
        await r2Client.send(new DeleteObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: deleteKey
        }));
    } catch (err) {
        console.warn(`Failed to delete R2 image: ${err.message}`);
    }
}

async function deleteStoredPhoto(deleteReference) {
    if (!deleteReference) return;
    if (USE_IMGBB) {
        await deletePhotoFromImgBB(deleteReference);
    } else if (USE_R2) {
        await deletePhotoFromR2(deleteReference);
    }
}

function getPhotoDataFromFile(file) {
    if (!file) {
        return { photoUrl: null, photoDeleteUrl: null };
    }
    if ((USE_IMGBB || USE_R2) && file.photoUrl) {
        return { photoUrl: file.photoUrl, photoDeleteUrl: file.photoDeleteUrl || null };
    }
    if (file.filename) {
        return { photoUrl: `/uploads/photos/${file.filename}`, photoDeleteUrl: null };
    }
    return { photoUrl: null, photoDeleteUrl: null };
}

function getPhotoDataForInsert(file) {
    const { photoUrl, photoDeleteUrl } = getPhotoDataFromFile(file);
    return {
        photoUrl: photoUrl || DEFAULT_PHOTO_URL,
        photoDeleteUrl: photoDeleteUrl || null
    };
}

function getPhotoDataForUpdate(file) {
    return getPhotoDataFromFile(file);
}

async function handleExternalUpload(req, res, next) {
    if ((!USE_IMGBB && !USE_R2) || !req.file) {
        return next();
    }

    try {
        if (USE_IMGBB) {
            const { url, deleteUrl } = await uploadPhotoToImgBB(req.file);
            req.file.photoUrl = url;
            req.file.photoDeleteUrl = deleteUrl;
            return next();
        }
        if (USE_R2) {
            const { url, deleteKey } = await uploadPhotoToR2(req.file);
            req.file.photoUrl = url;
            req.file.photoDeleteUrl = deleteKey;
            return next();
        }
    } catch (err) {
        console.error('Error uploading photo to external storage:', err);
        console.error('Error details:', {
            message: err.message,
            code: err.code,
            statusCode: err.$metadata?.httpStatusCode,
            name: err.name,
            stack: err.stack
        });
        return res.status(500).json({ error: 'Failed to upload photo to external storage.', details: err.message });
    }
}

async function initializeDatabase() {
    try {
        if (USING_POSTGRES) {
            await initializePostgresDatabase();
        } else {
            await initializeSqliteDatabase();
        }
        console.log('Database initialization complete.');
    } catch (err) {
        console.error('Failed to initialize database:', err);
        process.exit(1);
    }
}

async function initializeSqliteDatabase() {
    console.log(`Using SQLite database at ${dbFilePath}`);
    const addColumnIfMissing = async (table, column, definition) => {
        const columns = await allAsync(`PRAGMA table_info(${table})`);
        const exists = columns.some((col) => col.name === column);
        if (!exists) {
            await runAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
    };

    await runAsync(`CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        id_number TEXT NOT NULL,
        exam_number TEXT NOT NULL,
        student_name TEXT NOT NULL,
        photo_url TEXT,
        photo_delete_url TEXT,
        exam_type TEXT NOT NULL,
        level TEXT,
        exam_link TEXT,
        subjects_json TEXT NOT NULL,
        total_marks REAL NOT NULL,
        max_marks REAL,
        grade TEXT NOT NULL,
        exam_date TEXT NOT NULL,
        published INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    await runAsync(`CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    await addColumnIfMissing('students', 'published', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('students', 'level', 'TEXT');
    await addColumnIfMissing('students', 'exam_link', 'TEXT');
    await addColumnIfMissing('students', 'max_marks', 'REAL');
    await addColumnIfMissing('students', 'photo_delete_url', 'TEXT');

    const adminExists = await getAsync(`SELECT 1 FROM admins WHERE username = ? LIMIT 1`, ['admin']);
    if (!adminExists) {
        const bcrypt = require('bcryptjs');
        const hash = bcrypt.hashSync('admin123', 10);
        await runAsync(`INSERT INTO admins (username, password_hash) VALUES (?, ?)`, ['admin', hash]);
    }
}

async function initializePostgresDatabase() {
    console.log('Connecting to PostgreSQL database...');
    await runAsync(`CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        id_number TEXT NOT NULL,
        exam_number TEXT NOT NULL,
        student_name TEXT NOT NULL,
        photo_url TEXT,
        photo_delete_url TEXT,
        exam_type TEXT NOT NULL,
        level TEXT,
        exam_link TEXT,
        subjects_json TEXT NOT NULL,
        total_marks DOUBLE PRECISION NOT NULL,
        max_marks DOUBLE PRECISION,
        grade TEXT NOT NULL,
        exam_date TEXT NOT NULL,
        published BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);

    await runAsync(`CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);

    await runAsync(`ALTER TABLE students ADD COLUMN IF NOT EXISTS published BOOLEAN DEFAULT FALSE`);
    await runAsync(`ALTER TABLE students ADD COLUMN IF NOT EXISTS level TEXT`);
    await runAsync(`ALTER TABLE students ADD COLUMN IF NOT EXISTS exam_link TEXT`);
    await runAsync(`ALTER TABLE students ADD COLUMN IF NOT EXISTS max_marks DOUBLE PRECISION`);
    await runAsync(`ALTER TABLE students ADD COLUMN IF NOT EXISTS photo_delete_url TEXT`);

    const adminExists = await getAsync(`SELECT 1 FROM admins WHERE username = ? LIMIT 1`, ['admin']);
    if (!adminExists) {
        const bcrypt = require('bcryptjs');
        const hash = bcrypt.hashSync('admin123', 10);
        await runAsync(`INSERT INTO admins (username, password_hash) VALUES (?, ?)`, ['admin', hash]);
    }
}

initializeDatabase();

// Helper function placeholder for legacy SQLite compatibility.
function recreateTableWithoutUniqueConstraint(_db, callback) {
    if (USING_POSTGRES) {
        console.log('PostgreSQL schema already allows multiple rows per exam_number. Skipping legacy table recreation.');
    } else {
        console.log('SQLite schema already allows multiple rows per exam_number. Skipping legacy table recreation.');
    }
    if (callback) {
        setImmediate(() => callback(null));
    }
}

// Helper Functions
// Curved grading (percentile-based) without explicit max marks.
// Cohort = exam_type + level. Grade bands:
// Top 10% -> A, Next 20% -> B, Next 30% -> C, Next 20% -> D, Rest -> F
function assignGradesByPercentile(sortedTotalsDesc, cutoffs = [0.10, 0.30, 0.60, 0.80]) {
    const n = sortedTotalsDesc.length;
    if (n === 0) return [];
    return sortedTotalsDesc.map((total, index) => {
        const p = (index) / n; // 0-based index percentile
        const [a, b, c, d] = cutoffs;
        if (p < a) return 'A';
        if (p < b) return 'B';
        if (p < c) return 'C';
        if (p < d) return 'D';
        return 'F';
    });
}

function getCohortCutoffs(_examType, _level, cb) {
    // Use fixed defaults: Top 10% A, next 20% B, next 30% C, next 20% D, rest F
    return cb(null, [0.10, 0.30, 0.60, 0.80]);
}

function computeLetterGrade(total, max) {
    const t = Number(total) || 0;
    const m = Number(max) || 0;
    if (m <= 0 || isNaN(t) || isNaN(m)) {
        console.log(`[GRADE CALC] Invalid input: total=${total}, max=${max} -> N/A`);
        return 'N/A';
    }
    const p = (t / m) * 100;
    // Round to 2 decimal places for comparison
    const percentage = Math.round(p * 100) / 100;
    let grade = 'F';
    
    // Grading system: A+, A, B+, B, C+, C, D, E, F (Baasay)
    if (percentage >= 95) grade = 'A+';
    else if (percentage >= 90) grade = 'A';
    else if (percentage >= 85) grade = 'B+';
    else if (percentage >= 80) grade = 'B';
    else if (percentage >= 75) grade = 'C+';
    else if (percentage >= 70) grade = 'C+';
    else if (percentage >= 60) grade = 'C'; // C: 60-70%
    else if (percentage >= 50) grade = 'E'; // E: 50-60%
    else grade = 'F'; // F (Baasay): < 50%
    
    console.log(`[GRADE CALC] ${t}/${m} = ${percentage}% -> Grade ${grade}`);
    return grade;
}

function recomputeGradesForCohort(examType, level, callback = () => {}) {
    getCohortCutoffs(examType, level, (errCut, cutoffs) => {
        // Build query based on database type
        let query, params;
        if (USING_POSTGRES) {
            // PostgreSQL: use proper NULL handling
            if (level) {
                query = `SELECT id, total_marks, max_marks FROM students WHERE exam_type = $1 AND level = $2 ORDER BY id ASC`;
                params = [examType, level];
            } else {
                query = `SELECT id, total_marks, max_marks FROM students WHERE exam_type = $1 AND level IS NULL ORDER BY id ASC`;
                params = [examType];
            }
        } else {
            // SQLite: use ? placeholders
            query = `SELECT id, total_marks, max_marks FROM students WHERE exam_type = ? AND (level IS ? OR level = ?) ORDER BY id ASC`;
            params = [examType, null, level || null];
        }
        
        db.all(query, params, (err, rows) => {
            if (err) {
                console.error('Error fetching cohort for grade recompute:', err);
                callback(err);
                return;
            }
            const updates = rows.map((r) => ({ id: r.id, grade: computeLetterGrade(r.total_marks, r.max_marks) }));
            db.serialize(() => {
                const updateQuery = USING_POSTGRES 
                    ? `UPDATE students SET grade = $1 WHERE id = $2`
                    : `UPDATE students SET grade = ? WHERE id = ?`;
                const stmt = db.prepare(updateQuery);
                for (const u of updates) {
                    stmt.run([u.grade, u.id]);
                }
                stmt.finalize((finalizeErr) => {
                    if (finalizeErr) {
                        console.error('Error updating grades:', finalizeErr);
                        callback(finalizeErr);
                    } else {
                        callback(null);
                    }
                });
            });
        });
    });
}

function generateExamNumber() {
    return new Promise((resolve, reject) => {
        const year = new Date().getFullYear();
        db.get("SELECT exam_number FROM students ORDER BY id DESC LIMIT 1", (err, row) => {
            if (err) {
                reject(err);
            } else {
                let newNum = 1;
                if (row && row.exam_number) {
                    const match = row.exam_number.match(/\d+$/);
                    if (match) {
                        newNum = parseInt(match[0]) + 1;
                    }
                }
                resolve(`EX-${year}-${String(newNum).padStart(3, '0')}`);
            }
        });
    });
}

// API Routes

// Get all students (admin only)
app.get('/api/students', async (req, res) => {
    db.all("SELECT * FROM students ORDER BY created_at DESC", [], async (err, rows) => {
        if (err) {
            console.error('Error fetching students:', err);
            res.status(500).json({ error: err.message });
        } else {
            try {
                // Process students and generate QR codes
                const students = await Promise.all(rows.map(async (row) => {
                    try {
                        // Try to parse subjects_json, handle both object and array formats
                        let subjects = [];
                        if (row.subjects_json) {
                            const parsed = JSON.parse(row.subjects_json);
                            // If it's an object with midterm/final (Both type), keep it as is
                            // Otherwise convert to array if needed
                            subjects = parsed;
                        }
                        
                        // Generate QR code using id_number (primary identifier)
                        const qrUrl = `${req.protocol}://${req.get('host')}/result/${row.id_number || row.exam_number}`;
                        let qrCodeData = null;
                        try {
                            qrCodeData = await QRCode.toDataURL(qrUrl, {
                                errorCorrectionLevel: 'M',
                                type: 'image/png',
                                quality: 0.92,
                                margin: 1,
                                width: 300
                            });
                        } catch (qrErr) {
                            console.error('Error generating QR code for student', row.id, ':', qrErr);
                        }
                        
                        return {
                            ...row,
                            subjects: subjects,
                            qr_code_data: qrCodeData,
                            qr_url: qrUrl
                        };
                    } catch (parseErr) {
                        console.error('Error parsing subjects_json for student', row.id, ':', parseErr);
                        // Return student with empty subjects array if parsing fails
                        const qrUrl = `${req.protocol}://${req.get('host')}/result/${row.exam_number}`;
                        let qrCodeData = null;
                        try {
                            qrCodeData = await QRCode.toDataURL(qrUrl, {
                                errorCorrectionLevel: 'M',
                                type: 'image/png',
                                quality: 0.92,
                                margin: 1,
                                width: 300
                            });
                        } catch (qrErr) {
                            console.error('Error generating QR code for student', row.id, ':', qrErr);
                        }
                        
                        return {
                            ...row,
                            subjects: [],
                            qr_code_data: qrCodeData,
                            qr_url: qrUrl
                        };
                    }
                }));
                
                res.json(students);
            } catch (mapErr) {
                console.error('Error mapping students:', mapErr);
                res.status(500).json({ error: 'Error processing students data: ' + mapErr.message });
            }
        }
    });
});

// Get student result by exam number (public - only published)
// Returns ALL records with this exam_number (can be multiple: midterm, final, or both)
// Get result by ID number (public - only published)
// Supports both id_number (primary) and exam_number (backward compatibility)
app.get('/api/result/:identifier', (req, res) => {
    const identifier = req.params.identifier;
    // Try id_number first, then fallback to exam_number for backward compatibility
    db.all("SELECT * FROM students WHERE (id_number = ? OR exam_number = ?) AND published = TRUE ORDER BY exam_type ASC, created_at ASC", [identifier, identifier], async (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else if (!rows || rows.length === 0) {
            res.status(404).json({ error: 'Student not found' });
        } else {
            // Use id_number for QR code URL (primary identifier)
            const idNumber = rows[0].id_number || identifier;
            const qrUrl = `${req.protocol}://${req.get('host')}/result/${idNumber}`;
            
            // If only one record, return as single student (backward compatible)
            if (rows.length === 1) {
                const student = {
                    ...rows[0],
                    subjects: JSON.parse(rows[0].subjects_json)
                };
                
                try {
                    const qrCodeData = await QRCode.toDataURL(qrUrl);
                    student.qr_code_data = qrCodeData;
                    student.qr_url = qrUrl;
                    res.json({ success: true, student });
                } catch (qrErr) {
                    res.json({ success: true, student });
                }
            } else {
                // Multiple records (midterm + final) - return as array
                const students = rows.map(row => ({
                    ...row,
                    subjects: JSON.parse(row.subjects_json)
                }));
                
                try {
                    const qrCodeData = await QRCode.toDataURL(qrUrl);
                    res.json({ 
                        success: true, 
                        students: students,
                        student: students[0], // First one for backward compatibility
                        multiple: true,
                        qr_code_data: qrCodeData,
                        qr_url: qrUrl
                    });
                } catch (qrErr) {
                    res.json({ 
                        success: true, 
                        students: students,
                        student: students[0],
                        multiple: true
                    });
                }
            }
        }
    });
});

// Search result (public - only published)
// Returns ALL records with this id_number or exam_number (can be multiple: midterm, final, or both)
app.get('/api/result', (req, res) => {
    const identifier = req.query.exam || req.query.id;
    if (!identifier) {
        return res.status(400).json({ error: 'ID number or exam number required' });
    }
    
    // Try id_number first, then fallback to exam_number for backward compatibility
    db.all("SELECT * FROM students WHERE (id_number = ? OR exam_number = ?) AND published = TRUE ORDER BY exam_type ASC, created_at ASC", [identifier, identifier], async (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else if (!rows || rows.length === 0) {
            res.status(404).json({ error: 'Student not found' });
        } else {
            // Use id_number for QR code URL (primary identifier)
            const idNumber = rows[0].id_number || identifier;
            const qrUrl = `${req.protocol}://${req.get('host')}/result/${idNumber}`;
            
            // If only one record, return as single student (backward compatible)
            if (rows.length === 1) {
                const student = {
                    ...rows[0],
                    subjects: JSON.parse(rows[0].subjects_json)
                };
                
                try {
                    const qrCodeData = await QRCode.toDataURL(qrUrl);
                    student.qr_code_data = qrCodeData;
                    student.qr_url = qrUrl;
                    res.json({ success: true, student });
                } catch (qrErr) {
                    res.json({ success: true, student });
                }
            } else {
                // Multiple records (midterm + final) - return as array
                const students = rows.map(row => ({
                    ...row,
                    subjects: JSON.parse(row.subjects_json)
                }));
                
                try {
                    const qrCodeData = await QRCode.toDataURL(qrUrl);
                    res.json({ 
                        success: true, 
                        students: students,
                        student: students[0], // First one for backward compatibility
                        multiple: true,
                        qr_code_data: qrCodeData,
                        qr_url: qrUrl
                    });
                } catch (qrErr) {
                    res.json({ 
                        success: true, 
                        students: students,
                        student: students[0],
                        multiple: true
                    });
                }
            }
        }
    });
});

// Add student (admin only)
app.post('/api/students/add', upload.single('photo'), handleExternalUpload, (req, res) => {
    try {
        const { student_name, id_number, exam_number, exam_type, level, exam_link, subjects, exam_date, total_marks } = req.body;
        
        if (!student_name || !id_number) {
            return res.status(400).json({ error: 'Name and ID are required' });
        }

        let subjectsParsed = typeof subjects === 'string' ? JSON.parse(subjects) : subjects;
        
        // Handle subjects structure - can be array or object { midterm: [...], final: [...] }
        let totalMarks = 0;
        let grade = 'N/A';
        let finalSubjectsToStore = subjectsParsed;
        
        // Calculate obtained marks from subjects (for grading)
        // total_marks from form is actually max_marks (maximum possible marks like 400, 500)
        // We need to calculate obtained marks from subjects for percentile grading
        let obtainedMarks = 0;
        
        // If exam_type is "Both" and subjects is an object with midterm/final
        if (exam_type === 'Both' && subjectsParsed && typeof subjectsParsed === 'object' && !Array.isArray(subjectsParsed)) {
            // Calculate obtained from both midterm and final
            const midtermSubjects = subjectsParsed.midterm || [];
            const finalSubjects = subjectsParsed.final || [];
            const validMidterm = midtermSubjects.filter(s => s.name && s.name.trim() !== '');
            const validFinal = finalSubjects.filter(s => s.name && s.name.trim() !== '');
            const allSubjects = [...validMidterm, ...validFinal];
            
            if (allSubjects.length > 0) {
                obtainedMarks = allSubjects.reduce((sum, s) => sum + (parseFloat(s.mark) || 0), 0);
            }
            finalSubjectsToStore = subjectsParsed; // Keep object structure
        } else if (Array.isArray(subjectsParsed)) {
            // Handle array format (Midterm or Final only, or old format)
            const validSubjects = subjectsParsed.filter(s => s.name && s.name.trim() !== '');
            if (validSubjects.length > 0) {
                obtainedMarks = validSubjects.reduce((sum, s) => sum + (parseFloat(s.mark) || 0), 0);
            }
            finalSubjectsToStore = validSubjects;
        }
        
        // totalMarks in database = obtained marks (for percentile grading)
        totalMarks = obtainedMarks;

        // Step 1: Check if id_number exists with a DIFFERENT student_name - REJECT (ID must be unique per student)
        // But allow same student (same name) to have multiple exams (Midterm + Final)
        // First, get all records with this id_number
        db.all("SELECT DISTINCT student_name FROM students WHERE id_number = ?", [id_number], (checkErr0, checkRows0) => {
            if (checkErr0) {
                return res.status(500).json({ error: checkErr0.message });
            }
            
            // If id_number exists, check if any record has a DIFFERENT student name
            if (checkRows0 && checkRows0.length > 0) {
                // Normalize names for comparison (trim and lowercase)
                const normalizeName = (name) => (name || '').trim().toLowerCase();
                const newNameNormalized = normalizeName(student_name);
                
                // Check if any existing record has a different name
                const hasDifferentName = checkRows0.some(row => {
                    const existingNameNormalized = normalizeName(row.student_name);
                    return existingNameNormalized !== newNameNormalized && existingNameNormalized !== '';
                });
                
                if (hasDifferentName) {
                    return res.status(400).json({ error: `ID number "${id_number}" hore ayaa la qaatay (ID-gan waa inuu arday kale uu isticmaalo).` });
                }
                // If same name, allow (same student adding another exam type)
            }
            
            // If exam_number not provided, check if this student already has an exam_number to reuse
            let finalExamNumber = exam_number;
            if (!finalExamNumber) {
                // Check if this student already has an exam_number
                db.get("SELECT exam_number FROM students WHERE id_number = ? LIMIT 1", [id_number], (existingErr, existingRow) => {
                    if (existingErr) {
                        return res.status(500).json({ error: existingErr.message });
                    }
                    // If student already has an exam_number, reuse it. Otherwise generate new one.
                    if (existingRow && existingRow.exam_number) {
                        finalExamNumber = existingRow.exam_number;
                        continueWithExamNumber();
                    } else {
                        // Generate new exam number
                        generateExamNumber().then(genExamNum => {
                            finalExamNumber = genExamNum;
                            continueWithExamNumber();
                        }).catch(err => {
                            return res.status(500).json({ error: 'Failed to generate exam number: ' + err.message });
                        });
                    }
                });
            } else {
                continueWithExamNumber();
            }
            
            function continueWithExamNumber() {
            // Step 2: Check if exam_number exists with a DIFFERENT id_number - REJECT immediately
            db.get("SELECT id_number FROM students WHERE exam_number = ? AND id_number != ? LIMIT 1", [finalExamNumber, id_number], (checkErr1, checkRow1) => {
                if (checkErr1) {
                    return res.status(500).json({ error: checkErr1.message });
                }
                
                // If exam_number exists for a different student, REJECT
                if (checkRow1) {
                    return res.status(400).json({ error: 'Exam number already exists for another student. Each student must have a unique exam number.' });
                }
                
                // Step 3: Check if same student (same id_number) already has this exam_number with same exam_type - UPDATE
                db.get("SELECT id, id_number, exam_type, photo_delete_url FROM students WHERE exam_number = ? AND id_number = ? AND exam_type = ?", [finalExamNumber, id_number, exam_type], (checkErr2, checkRow2) => {
                    if (checkErr2) {
                        return res.status(500).json({ error: checkErr2.message });
                    }
                    
                    if (checkRow2) {
                    // Same student, same exam_number, same exam_type - UPDATE existing record
                    const existingId = checkRow2.id;
                const previousPhotoDeleteUrl = checkRow2.photo_delete_url;
                const { photoUrl: newPhotoUrl, photoDeleteUrl: newPhotoDeleteUrl } = getPhotoDataForUpdate(req.file);
                    const examDate = exam_date || new Date().toISOString().split('T')[0];
                    
                    const maxMarks = parseFloat(total_marks) || ((Array.isArray(finalSubjectsToStore) ? finalSubjectsToStore.length : 0) * 100);
                    const computedGrade = computeLetterGrade(totalMarks, maxMarks);
                    db.run(
                    `UPDATE students SET student_name = ?, level = ?, exam_link = ?, subjects_json = ?, total_marks = ?, max_marks = ?, grade = ?, exam_date = ?, photo_url = COALESCE(?, photo_url), photo_delete_url = COALESCE(?, photo_delete_url) WHERE id = ?`,
                    [student_name, level || null, exam_link || null, JSON.stringify(finalSubjectsToStore), totalMarks, maxMarks, computedGrade, examDate, newPhotoUrl, newPhotoDeleteUrl, existingId],
                        async function(updateErr) {
                            if (updateErr) {
                                console.error('Update Error:', updateErr);
                                return res.status(500).json({ error: updateErr.message });
                            }
                        if ((USE_IMGBB || USE_R2) && newPhotoDeleteUrl && previousPhotoDeleteUrl && previousPhotoDeleteUrl !== newPhotoDeleteUrl) {
                            await deleteStoredPhoto(previousPhotoDeleteUrl);
                            }
                            // Recompute grades for this cohort asynchronously
                            recomputeGradesForCohort(exam_type, level || null);
                            // Generate QR code using id_number (primary identifier)
                            const qrUrl = `${req.protocol}://${req.get('host')}/result/${id_number}`;
                            try {
                                const qrCodeData = await QRCode.toDataURL(qrUrl, {
                                    errorCorrectionLevel: 'M',
                                    type: 'image/png',
                                    quality: 0.92,
                                    margin: 1,
                                    width: 300
                                });
                                return res.json({ 
                                    success: true, 
                                    message: `Student ${exam_type} record updated successfully`,
                                    student: {
                                        id: existingId,
                                        exam_number: finalExamNumber,
                                        qr_code_data: qrCodeData,
                                        qr_url: qrUrl
                                    }
                                });
                            } catch (qrErr) {
                                console.error('QR Code generation error:', qrErr);
                                return res.json({ 
                                    success: true, 
                                    message: `Student ${exam_type} record updated successfully`,
                                    student: {
                                        id: existingId,
                                        exam_number: finalExamNumber,
                                        qr_url: qrUrl
                                    }
                                });
                            }
                        }
                    );
                    return;
                    }
                    
                    // Step 4: Same student, same exam_number, but different exam_type (Midterm vs Final) - ALLOW INSERT
                    // OR completely new exam_number - ALLOW INSERT
                const { photoUrl: insertPhotoUrl, photoDeleteUrl: insertPhotoDeleteUrl } = getPhotoDataForInsert(req.file);

                const examDate = exam_date || new Date().toISOString().split('T')[0];
                const maxMarks = parseFloat(total_marks) || ((Array.isArray(finalSubjectsToStore) ? finalSubjectsToStore.length : 0) * 100);
                const computedGrade = computeLetterGrade(totalMarks, maxMarks);

                db.run(
                    `INSERT INTO students (id_number, exam_number, student_name, photo_url, photo_delete_url, exam_type, level, exam_link, subjects_json, total_marks, max_marks, grade, exam_date, published)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE)
                     RETURNING id`,
                    [id_number, finalExamNumber, student_name, insertPhotoUrl, insertPhotoDeleteUrl, exam_type, level || null, exam_link || null, JSON.stringify(finalSubjectsToStore), totalMarks, maxMarks, computedGrade, examDate],
                    async function(err, result) {
                        if (err) {
                            // If UNIQUE constraint error (old database), check the situation
                            const duplicateError = err.message.includes('UNIQUE constraint') || err.message.includes('unique constraint') || err.message.includes('duplicate key value');
                            if (duplicateError) {
                                // Check all records with this exam_number
                                db.all("SELECT id, id_number, exam_type, photo_delete_url FROM students WHERE exam_number = ?", [finalExamNumber], (checkErr3, checkRows3) => {
                                    if (checkErr3) {
                                        return res.status(500).json({ error: checkErr3.message });
                                    }
                                    
                                    // Check if any record belongs to a different student
                                    const differentStudent = checkRows3.find(row => row.id_number !== id_number);
                                    if (differentStudent) {
                                        return res.status(400).json({ error: 'Exam number already exists for another student. Each student must have a unique exam number.' });
                                    }
                                    
                                    // All records belong to same student - check if same exam_type already exists
                                    const sameExamType = checkRows3.find(row => row.exam_type === exam_type);
                                    if (sameExamType) {
                                        // Same student, same exam_type - should have been caught earlier, but update anyway
                                        const maxMarksForUpdate = parseFloat(total_marks) || ((Array.isArray(finalSubjectsToStore) ? finalSubjectsToStore.length : 0) * 100);
                                        const computedGradeForUpdate = computeLetterGrade(totalMarks, maxMarksForUpdate);
                                        const { photoUrl: duplicateUpdatePhotoUrl, photoDeleteUrl: duplicateUpdatePhotoDeleteUrl } = getPhotoDataForUpdate(req.file);
                                        db.run(
                                            `UPDATE students SET student_name = ?, level = ?, exam_link = ?, subjects_json = ?, total_marks = ?, max_marks = ?, grade = ?, exam_date = ?, photo_url = COALESCE(?, photo_url), photo_delete_url = COALESCE(?, photo_delete_url) WHERE id = ?`,
                                            [student_name, level || null, exam_link || null, JSON.stringify(finalSubjectsToStore), totalMarks, maxMarksForUpdate, computedGradeForUpdate, examDate, duplicateUpdatePhotoUrl, duplicateUpdatePhotoDeleteUrl, sameExamType.id],
                                            async function(updateErr) {
                                                if (updateErr) {
                                                    return res.status(500).json({ error: 'Failed to update: ' + updateErr.message });
                                                }
                                                if ((USE_IMGBB || USE_R2) && duplicateUpdatePhotoDeleteUrl && sameExamType.photo_delete_url && sameExamType.photo_delete_url !== duplicateUpdatePhotoDeleteUrl) {
                                                    await deleteStoredPhoto(sameExamType.photo_delete_url);
                                                }
                                                recomputeGradesForCohort(exam_type, level || null);
                                                // Generate QR code using id_number (primary identifier)
                                                const qrUrl = `${req.protocol}://${req.get('host')}/result/${id_number}`;
                                                try {
                                                    const qrCodeData = await QRCode.toDataURL(qrUrl, {
                                                        errorCorrectionLevel: 'M',
                                                        type: 'image/png',
                                                        quality: 0.92,
                                                        margin: 1,
                                                        width: 300
                                                    });
                                                    return res.json({ 
                                                        success: true, 
                                                        message: `Student ${exam_type} record updated successfully`,
                                                        student: {
                                                            id: sameExamType.id,
                                                            exam_number: finalExamNumber,
                                                            qr_code_data: qrCodeData,
                                                            qr_url: qrUrl
                                                        }
                                                    });
                                                } catch (qrErr) {
                                                    console.error('QR Code generation error:', qrErr);
                                                    return res.json({ 
                                                        success: true, 
                                                        message: `Student ${exam_type} record updated successfully`,
                                                        student: {
                                                            id: sameExamType.id,
                                                            exam_number: finalExamNumber,
                                                            qr_url: qrUrl
                                                        }
                                                    });
                                                }
                                            }
                                        );
                                    } else {
                                        // Same student, different exam_type - UNIQUE constraint prevents INSERT
                                        // Solution: Create new table, copy data, replace old table
                                        // But for now, let's try a workaround: use a modified exam_number temporarily
                                        // Actually, better: recreate table without UNIQUE constraint
                                        console.log('Attempting to fix UNIQUE constraint issue...');
                                        recreateTableWithoutUniqueConstraint(db, function(recreateErr) {
                                            if (recreateErr) {
                                                return res.status(400).json({ 
                                                    error: 'Cannot add second exam for same student: Database constraint. Please contact administrator to fix the database.' 
                                                });
                                            }
                                            // Retry the insert after recreating table
                                            const maxMarks = parseFloat(total_marks) || ((Array.isArray(finalSubjectsToStore) ? finalSubjectsToStore.length : 0) * 100);
                                            db.run(
                                                `INSERT INTO students (id_number, exam_number, student_name, photo_url, photo_delete_url, exam_type, level, exam_link, subjects_json, total_marks, max_marks, grade, exam_date, published)
                                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE)
                                                 RETURNING id`,
                                                [id_number, finalExamNumber, student_name, insertPhotoUrl, insertPhotoDeleteUrl, exam_type, level || null, exam_link || null, JSON.stringify(finalSubjectsToStore), totalMarks, maxMarks, computeLetterGrade(totalMarks, maxMarks), examDate],
                                                async function(retryErr, retryResult) {
                                                    if (retryErr) {
                                                        return res.status(500).json({ error: 'Failed after fix: ' + retryErr.message });
                                                    }
                                                    const insertedId = retryResult?.rows && retryResult.rows[0] ? retryResult.rows[0].id : null;
                                                    // Generate QR code using id_number (primary identifier)
                                                    const qrUrl = `${req.protocol}://${req.get('host')}/result/${id_number}`;
                                                    try {
                                                        const qrCodeData = await QRCode.toDataURL(qrUrl, {
                                                            errorCorrectionLevel: 'M',
                                                            type: 'image/png',
                                                            quality: 0.92,
                                                            margin: 1,
                                                            width: 300
                                                        });
                                                        return res.json({ 
                                                            success: true, 
                                                            message: 'Student added successfully (database fixed)',
                                                            student: {
                                                                id: insertedId,
                                                                exam_number: finalExamNumber,
                                                                qr_code_data: qrCodeData,
                                                                qr_url: qrUrl
                                                            }
                                                        });
                                                    } catch (qrErr) {
                                                        console.error('QR Code generation error:', qrErr);
                                                        return res.json({ 
                                                            success: true, 
                                                            message: 'Student added successfully (database fixed)',
                                                            student: {
                                                                id: insertedId,
                                                                exam_number: finalExamNumber,
                                                                qr_url: qrUrl
                                                            }
                                                        });
                                                    }
                                                }
                                            );
                                        });
                                    }
                                });
                            } else {
                                res.status(500).json({ error: err.message });
                            }
                        } else {
                            const insertedId = result?.rows && result.rows[0] ? result.rows[0].id : null;
                            // Generate QR code using id_number (primary identifier)
                            const qrUrl = `${req.protocol}://${req.get('host')}/result/${id_number}`;
                            try {
                                const qrCodeData = await QRCode.toDataURL(qrUrl, {
                                    errorCorrectionLevel: 'M',
                                    type: 'image/png',
                                    quality: 0.92,
                                    margin: 1,
                                    width: 300
                                });
                                res.json({ 
                                    success: true, 
                                    message: 'Student added successfully',
                                    student: {
                                        id: insertedId,
                                        exam_number: finalExamNumber,
                                        qr_code_data: qrCodeData,
                                        qr_url: qrUrl
                                    }
                                });
                            } catch (qrErr) {
                                console.error('QR Code generation error:', qrErr);
                                res.json({ 
                                    success: true, 
                                    message: 'Student added successfully',
                                    student: {
                                        id: insertedId,
                                        exam_number: finalExamNumber,
                                        qr_url: qrUrl
                                    }
                                });
                            }
                        }
                    }
                );
            });
        });
            } // Close continueWithExamNumber function
        }); // Close db.all for checkRows0
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Download QR code as image file - MUST BE BEFORE /api/students/:id routes
app.get('/api/students/:id/qr-download', async (req, res) => {
    console.log('QR download route hit:', req.params.id); // Debug log
    const studentId = req.params.id;
    db.get("SELECT exam_number, student_name FROM students WHERE id = ?", [studentId], async (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else if (!row) {
            res.status(404).json({ error: 'Student not found' });
        } else {
            const qrUrl = `${req.protocol}://${req.get('host')}/result/${row.exam_number}`;
            try {
                const qrCodeBuffer = await QRCode.toBuffer(qrUrl, {
                    errorCorrectionLevel: 'M',
                    type: 'png',
                    width: 500
                });
                res.setHeader('Content-Type', 'image/png');
                const safeFilename = `${row.exam_number}.png`;
                res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
                res.send(qrCodeBuffer);
            } catch (qrErr) {
                console.error('QR Download Error:', qrErr);
                res.status(500).json({ error: 'Error generating QR code' });
            }
        }
    });
});

// Get QR code data URL for printing - MUST BE BEFORE /api/students/:id routes  
app.get('/api/students/:id/qr', async (req, res) => {
    console.log('QR code route hit:', req.params.id); // Debug log
    const studentId = req.params.id;
    db.get("SELECT exam_number FROM students WHERE id = ?", [studentId], async (err, row) => {
        if (err) {
            console.error('QR Code DB Error:', err);
            res.status(500).json({ error: err.message });
        } else if (!row) {
            res.status(404).json({ error: 'Student not found' });
        } else {
            const qrUrl = `${req.protocol}://${req.get('host')}/result/${row.exam_number}`;
            try {
                const qrCodeData = await QRCode.toDataURL(qrUrl, {
                    errorCorrectionLevel: 'M',
                    type: 'image/png',
                    quality: 0.92,
                    margin: 1,
                    width: 300
                });
                res.json({ success: true, qr_code_data: qrCodeData, qr_url: qrUrl });
            } catch (qrErr) {
                console.error('QR Code Generation Error:', qrErr);
                res.status(500).json({ error: 'Error generating QR code: ' + qrErr.message });
            }
        }
    });
});

// Publish/Unpublish student - MUST BE BEFORE /api/students/:id routes
app.put('/api/students/:id/publish', (req, res) => {
    const studentId = req.params.id;
    const { published } = req.body;
    db.run("UPDATE students SET published = ? WHERE id = ?", [published ? true : false, studentId], (err) => {
        if (err) {
            console.error('Publish Error:', err);
            res.status(500).json({ error: err.message });
        } else {
            res.json({ success: true, message: `Student ${published ? 'published' : 'unpublished'}` });
        }
    });
});

// Update student
app.put('/api/students/:id', upload.single('photo'), handleExternalUpload, (req, res) => {
    const { student_name, id_number, exam_type, level, exam_link, subjects, exam_date, total_marks } = req.body;
    const studentId = req.params.id;

    // Check if id_number/name change conflicts with ownership rules
    db.get("SELECT id, student_name, id_number, photo_delete_url FROM students WHERE id = ?", [studentId], (err, currentRow) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!currentRow) {
            return res.status(404).json({ error: 'Student not found' });
        }
        
        const newIdNumber = id_number || currentRow.id_number;
        const incomingName = (student_name || '').trim().toLowerCase();
        const currentName = (currentRow.student_name || '').trim().toLowerCase();

        // Check all other records with the same id_number
        db.all("SELECT id, student_name FROM students WHERE id_number = ? AND id != ?", [newIdNumber, studentId], (checkErr, rows) => {
            if (checkErr) {
                return res.status(500).json({ error: checkErr.message });
            }

            // If no other records use this ID, safe to proceed
            if (!rows || rows.length === 0) {
                return proceedWithUpdate();
            }

            // Normalize names for comparison
            const otherNames = Array.from(new Set(rows.map(r => (r.student_name || '').trim().toLowerCase())));

            // Allow update and synchronize names across this id_number to the incoming name
            // as long as an incomingName is provided. This supports editing either exam of the same student.
            if (incomingName && incomingName.length > 0) {
                return proceedWithUpdate();
            }

            // If no name provided, and there are existing records with this ID, block to avoid ambiguity
            return res.status(400).json({ error: `ID number "${newIdNumber}" already exists. Please provide the student's name to continue.` });
        });
        
        function proceedWithUpdate() {

    let subjectsParsed = typeof subjects === 'string' ? JSON.parse(subjects) : subjects;
    
    // Handle subjects structure - can be array or object { midterm: [...], final: [...] }
    let totalMarks = 0;
    let grade = 'N/A';
    let finalSubjectsToStore = subjectsParsed;
    
    // Calculate obtained marks from subjects (for grading)
    // total_marks from form is actually max_marks (maximum possible marks like 400, 500)
    // We need to calculate obtained marks from subjects for percentile grading
    let obtainedMarks = 0;
    
    // If exam_type is "Both" and subjects is an object with midterm/final
    if (exam_type === 'Both' && subjectsParsed && typeof subjectsParsed === 'object' && !Array.isArray(subjectsParsed)) {
        // Calculate obtained from both midterm and final
        const midtermSubjects = subjectsParsed.midterm || [];
        const finalSubjects = subjectsParsed.final || [];
        const validMidterm = midtermSubjects.filter(s => s.name && s.name.trim() !== '');
        const validFinal = finalSubjects.filter(s => s.name && s.name.trim() !== '');
        const allSubjects = [...validMidterm, ...validFinal];
        
        if (allSubjects.length > 0) {
            obtainedMarks = allSubjects.reduce((sum, s) => sum + (parseFloat(s.mark) || 0), 0);
        }
        finalSubjectsToStore = subjectsParsed; // Keep object structure
    } else if (Array.isArray(subjectsParsed)) {
        // Handle array format (Midterm or Final only, or old format)
        const validSubjects = subjectsParsed.filter(s => s.name && s.name.trim() !== '');
        if (validSubjects.length > 0) {
            obtainedMarks = validSubjects.reduce((sum, s) => sum + (parseFloat(s.mark) || 0), 0);
        }
        finalSubjectsToStore = validSubjects;
    }
    
    // totalMarks in database = obtained marks (for percentile grading)
    totalMarks = obtainedMarks;

    const maxMarks = parseFloat(total_marks) || ((Array.isArray(finalSubjectsToStore) ? finalSubjectsToStore.length : 0) * 100);
    const gradeToStore = computeLetterGrade(totalMarks, maxMarks);
    const { photoUrl: updatePhotoUrl, photoDeleteUrl: updatePhotoDeleteUrl } = getPhotoDataForUpdate(req.file);

    const updateQuery = `UPDATE students SET student_name = ?, id_number = ?, exam_type = ?, level = ?, exam_link = ?,
                       subjects_json = ?, total_marks = ?, max_marks = ?, grade = ?, exam_date = ?, photo_url = COALESCE(?, photo_url), photo_delete_url = COALESCE(?, photo_delete_url)
                       WHERE id = ?`;
    const params = [student_name, id_number, exam_type, level || null, exam_link || null, JSON.stringify(finalSubjectsToStore), totalMarks, maxMarks, gradeToStore, exam_date, updatePhotoUrl, updatePhotoDeleteUrl, studentId];

    // Get id_number and exam_number for QR code generation
    db.get("SELECT id_number, exam_number FROM students WHERE id = ?", [studentId], async (err, studentRow) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (!studentRow) {
            return res.status(404).json({ error: 'Student not found' });
        }
        
        db.run(updateQuery, params, async (err) => {
            if (err) {
                console.error('Update Error:', err);
                res.status(500).json({ error: err.message });
            } else {
                if ((USE_IMGBB || USE_R2) && updatePhotoDeleteUrl && currentRow.photo_delete_url && currentRow.photo_delete_url !== updatePhotoDeleteUrl) {
                    await deleteStoredPhoto(currentRow.photo_delete_url);
                }
                // Keep name consistent across all records with same id_number
                const normalizedName = (student_name || '').trim();
                const idNumToSync = id_number || studentRow.id_number;
                try {
                    await new Promise((resolve, reject) => {
                        db.run("UPDATE students SET student_name = ? WHERE id_number = ?", [normalizedName, idNumToSync], function(syncErr) {
                            if (syncErr) return reject(syncErr);
                            resolve();
                        });
                    });
                } catch (syncErr) {
                    console.warn('Name sync warning:', syncErr.message);
                }
                // Recompute grades for this cohort asynchronously
                recomputeGradesForCohort(exam_type, level || null);
                
                // Use updated id_number (from params) or fallback to existing
                const idNumberForQR = id_number || studentRow.id_number;
                // Generate QR code using id_number (primary identifier)
                const qrUrl = `${req.protocol}://${req.get('host')}/result/${idNumberForQR}`;
                try {
                    const qrCodeData = await QRCode.toDataURL(qrUrl, {
                        errorCorrectionLevel: 'M',
                        type: 'image/png',
                        quality: 0.92,
                        margin: 1,
                        width: 300
                    });
                    res.json({ 
                        success: true, 
                        message: 'Student updated successfully',
                        student: {
                            id: studentId,
                            exam_number: studentRow.exam_number,
                            qr_code_data: qrCodeData,
                            qr_url: qrUrl
                        }
                    });
                } catch (qrErr) {
                    console.error('QR Code generation error:', qrErr);
                    res.json({ 
                        success: true, 
                        message: 'Student updated successfully',
                        student: {
                            id: studentId,
                            exam_number: studentRow.exam_number,
                            qr_url: qrUrl
                        }
                    });
                }
            }
        });
    });
        } // Close proceedWithUpdate function
    }); // Close db.get for currentRow
});

// Delete student - MUST BE AFTER specific routes like /api/students/:id/qr
app.delete('/api/students/:id', (req, res) => {
    console.log('DELETE route hit for student ID:', req.params.id); // Debug log
    const studentId = req.params.id;
    
    // First check if student exists
    db.get("SELECT id, photo_delete_url FROM students WHERE id = ?", [studentId], (err, row) => {
        if (err) {
            console.error('Delete Check Error:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
        
        if (!row) {
            console.log('Student not found for deletion:', studentId);
            return res.status(404).json({ success: false, error: 'Student not found' });
        }
        
        // Delete the student
        const photoDeleteUrl = row.photo_delete_url;
        db.run("DELETE FROM students WHERE id = ?", [studentId], async function(deleteErr) {
            if (deleteErr) {
                console.error('Delete Error:', deleteErr);
                return res.status(500).json({ success: false, error: deleteErr.message });
            }
            
            if ((USE_IMGBB || USE_R2) && photoDeleteUrl) {
                await deleteStoredPhoto(photoDeleteUrl);
            }
            
            console.log('Student deleted successfully:', studentId);
            res.json({ 
                success: true, 
                message: 'Student deleted successfully',
                deletedId: studentId
            });
        });
    });
});

// Publish all students
app.post('/api/students/publish-all', (req, res) => {
    db.run("UPDATE students SET published = TRUE", [], function(err, result) {
        if (err) {
            console.error('Publish All Error:', err);
            res.status(500).json({ error: err.message });
        } else {
            const updatedCount = result?.rowCount ?? this.changes;
            res.json({ success: true, message: `All students published (${updatedCount} updated)` });
        }
    });
});

// Export CSV
app.get('/api/students/export', (req, res) => {
    db.all("SELECT * FROM students ORDER BY created_at DESC", [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            const csv = [
                ['ID Number', 'Exam Number', 'Name', 'Exam Type', 'Subjects', 'Total Marks', 'Grade', 'Exam Date'].join(','),
                ...rows.map(row => {
                    const subjects = JSON.parse(row.subjects_json);
                    const subjectsStr = subjects.map(s => `${s.name}: ${s.mark}`).join('; ');
                    return [
                        row.id_number,
                        row.exam_number,
                        `"${row.student_name}"`,
                        row.exam_type,
                        `"${subjectsStr}"`,
                        row.total_marks,
                        row.grade,
                        row.exam_date
                    ].join(',');
                })
            ].join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=students_export_${Date.now()}.csv`);
            res.send(csv);
        }
    });
});

// Admin login
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const bcrypt = require('bcryptjs');
    
    db.get("SELECT * FROM admins WHERE username = ?", [username], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else if (!row) {
            res.status(401).json({ error: 'Invalid credentials' });
        } else {
            if (bcrypt.compareSync(password, row.password_hash)) {
                res.json({ success: true, message: 'Login successful', admin: { id: row.id, username: row.username } });
            } else {
                res.status(401).json({ error: 'Invalid credentials' });
            }
        }
    });
});

// Get current admin info (requires login - simple check)
app.get('/api/admin/info', (req, res) => {
    // This is a simple endpoint - in production, you'd use proper session/auth middleware
    db.all("SELECT id, username, created_at FROM admins ORDER BY created_at ASC", [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json({ success: true, admins: rows });
        }
    });
});

// Update admin password - must be before any catch-all middleware
app.put('/api/admin/password', (req, res) => {
    console.log('[ROUTE] PUT /api/admin/password MATCHED');
    console.log('[ROUTE] Request path:', req.path);
    console.log('[ROUTE] Request originalUrl:', req.originalUrl);
    console.log('[ROUTE] Request body:', { username: req.body?.username, hasPassword: !!req.body?.currentPassword, hasNewPassword: !!req.body?.newPassword });
    const { username, currentPassword, newPassword } = req.body;
    const bcrypt = require('bcryptjs');
    
    if (!username || !currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Username, current password, and new password are required' });
    }
    
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }
    
    db.get("SELECT * FROM admins WHERE username = ?", [username], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else if (!row) {
            res.status(404).json({ error: 'Admin not found' });
        } else {
            // Verify current password
            if (bcrypt.compareSync(currentPassword, row.password_hash)) {
                // Hash new password
                const newHash = bcrypt.hashSync(newPassword, 10);
                db.run("UPDATE admins SET password_hash = ? WHERE username = ?", [newHash, username], (updateErr) => {
                    if (updateErr) {
                        res.status(500).json({ error: updateErr.message });
                    } else {
                        res.json({ success: true, message: 'Password updated successfully' });
                    }
                });
            } else {
                res.status(401).json({ error: 'Current password is incorrect' });
            }
        }
    });
});

// Update admin username - must be before any catch-all middleware
app.put('/api/admin/username', (req, res) => {
    console.log('[ROUTE] PUT /api/admin/username MATCHED');
    console.log('[ROUTE] Request path:', req.path);
    console.log('[ROUTE] Request originalUrl:', req.originalUrl);
    console.log('[ROUTE] Request body:', { currentUsername: req.body?.currentUsername, newUsername: req.body?.newUsername, hasPassword: !!req.body?.password });
    const { currentUsername, newUsername, password } = req.body;
    const bcrypt = require('bcryptjs');
    
    if (!currentUsername || !newUsername || !password) {
        return res.status(400).json({ error: 'Current username, new username, and password are required' });
    }
    
    if (newUsername.length < 3) {
        return res.status(400).json({ error: 'New username must be at least 3 characters long' });
    }
    
    db.get("SELECT * FROM admins WHERE username = ?", [currentUsername], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else if (!row) {
            res.status(404).json({ error: 'Admin not found' });
        } else {
            // Verify password
            if (bcrypt.compareSync(password, row.password_hash)) {
                // Check if new username already exists
                db.get("SELECT * FROM admins WHERE username = ?", [newUsername], (checkErr, checkRow) => {
                    if (checkErr) {
                        res.status(500).json({ error: checkErr.message });
                    } else if (checkRow) {
                        res.status(400).json({ error: 'Username already exists' });
                    } else {
                        db.run("UPDATE admins SET username = ? WHERE username = ?", [newUsername, currentUsername], (updateErr) => {
                            if (updateErr) {
                                res.status(500).json({ error: updateErr.message });
                            } else {
                                res.json({ success: true, message: 'Username updated successfully', newUsername: newUsername });
                            }
                        });
                    }
                });
            } else {
                res.status(401).json({ error: 'Password is incorrect' });
            }
        }
    });
});

// Handle 404 for API routes - This will ONLY catch routes that weren't matched by app.put(), app.post(), etc.
// Express matches specific routes (app.put, app.post) BEFORE middleware (app.use), so this is safe
app.use((req, res, next) => {
    // Only handle API routes that weren't matched by previous routes
    if (req.path && req.path.startsWith('/api/')) {
        // Log full request details for debugging
        console.log(`[404] API endpoint not found: ${req.method} ${req.path || '(empty)'}`);
        console.log(`[404] Full URL: ${req.protocol}://${req.get('host')}${req.originalUrl || req.url}`);
        console.log(`[404] Original URL: ${req.originalUrl || req.url}`);
        console.log(`[404] Route was not matched by any app.put() or app.post() handler`);
        return res.status(404).json({ 
            success: false, 
            error: `API endpoint not found: ${req.method} ${req.path || '/'}` 
        });
    }
    next();
});

// Handle any other PUT/POST/DELETE requests to non-API routes
app.use((req, res, next) => {
    if (req.method !== 'GET' && !req.path.startsWith('/api/')) {
        console.log(`[404] Unhandled ${req.method} request to: ${req.path}`);
        console.log(`[404] Original URL: ${req.originalUrl}`);
        console.log(`[404] Full URL: ${req.protocol}://${req.get('host')}${req.originalUrl}`);
        res.status(404).json({ 
            success: false, 
            error: `Endpoint not found: ${req.method} ${req.path}` 
        });
    } else {
        next();
    }
});

// Keep-alive endpoint for uptime monitoring (Replit, UptimeRobot, etc.)
app.get('/keep-alive', (req, res) => {
    res.status(200).json({ 
        status: 'alive', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString()
    });
});

// Grading settings APIs
// Grading settings endpoints removed; fixed defaults are used.

// Serve React app for all other routes (must be last)
app.get('*', (req, res, next) => {
    // Don't serve HTML for API routes or static files
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
        return next();
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Recalculate all student grades (admin endpoint)
app.post('/api/admin/recalculate-grades', (req, res) => {
    db.all("SELECT id, total_marks, max_marks FROM students", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        const updates = rows.map((r) => ({ 
            id: r.id, 
            grade: computeLetterGrade(r.total_marks, r.max_marks),
            total: r.total_marks,
            max: r.max_marks,
            percentage: r.max_marks > 0 ? ((r.total_marks / r.max_marks) * 100).toFixed(2) : 'N/A'
        }));
        
        db.serialize(() => {
            const stmt = db.prepare(`UPDATE students SET grade = ? WHERE id = ?`);
            let updated = 0;
            let errors = [];
            
            for (const u of updates) {
                try {
                    stmt.run([u.grade, u.id]);
                    updated++;
                } catch (e) {
                    errors.push({ id: u.id, error: e.message });
                }
            }
            
            stmt.finalize((finalizeErr) => {
                if (finalizeErr) {
                    return res.status(500).json({ error: 'Error finalizing grade updates: ' + finalizeErr.message });
                }
                res.json({ 
                    success: true, 
                    message: `Recalculated grades for ${updated} students`,
                    updated: updated,
                    errors: errors.length > 0 ? errors : undefined,
                    sample: updates.slice(0, 5) // Show first 5 as sample
                });
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Keep-alive endpoint: http://localhost:${PORT}/keep-alive`);
});

