# Exam Results Portal 2025
## Machad Khabab

### Setup Instructions

1. **Install Dependencies:**
```bash
npm install
```

2. **Add Logo:**
   - Place your logo image at: `public/assets/logo.jpg`
   - The logo will appear in the header of all pages

3. **Configure Environment:**
   - Defaults to SQLite (`DB_CLIENT=sqlite`). For Postgres set:
     ```
     DB_CLIENT=postgres
     DATABASE_URL=postgres://user:pass@host:5432/dbname
     ```
   - Optional:
     - `IMGBB_API_KEY` for cloud photo storage
     - `DEFAULT_PHOTO_URL` override

4. **Start Server:**
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

5. **Access the Website:**
   - Main page: http://localhost:5000
   - Admin login: Click "Admin Login" link
   - Default admin credentials:
     - Username: `admin`
     - Password: `admin123`

### Features

✅ Modern Islamic-themed design (light green + white gradient)
✅ Responsive layout (mobile, tablet, desktop)
✅ QR code scanning for mobile devices
✅ PDF download functionality
✅ Print result functionality
✅ Student photo upload
✅ CSV export for admin
✅ Auto-generate exam numbers
✅ Dynamic subject entry
✅ Real-time grade calculation

### File Structure

```
├── server.js              # Express backend server
├── package.json           # Node.js dependencies
├── students.db            # SQLite database (auto-created)
├── public/
│   ├── index.html         # React frontend
│   └── assets/
│       └── logo.jpg       # Institute logo
└── uploads/
    └── photos/            # Uploaded student photos
```

### Technology Stack

- **Backend:** Node.js + Express + SQLite (default) / PostgreSQL
- **Frontend:** React + TailwindCSS
- **QR Codes:** qrcode npm package
- **PDF Generation:** jsPDF
- **File Uploads:** Multer
- **QR Scanning:** html5-qrcode

