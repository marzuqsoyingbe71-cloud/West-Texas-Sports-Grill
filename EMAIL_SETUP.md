# Email Notifications Setup

To receive email notifications for orders, reservations, and reviews, follow these steps:

## 1. Install Dependencies
Run this command in the project directory:
```bash
npm install
```

This will install `nodemailer` which is now listed in `package.json`.

## 2. Set Up Email Configuration

You have two options:

### Option A: Using Gmail (Recommended for quick setup)

1. Go to your Google Account settings: https://myaccount.google.com/security
2. Enable "2-Step Verification" if not already enabled
3. Create an "App Password":
   - Go to Security > App passwords
   - Select "Mail" and "Windows Computer"
   - Copy the 16-character password provided

4. Set environment variables in your terminal before starting the server:

**Windows (PowerShell):**
```powershell
$env:SMTP_USER = "your-email@gmail.com"
$env:SMTP_PASS = "your-app-password"
$env:SMTP_HOST = "smtp.gmail.com"
$env:SMTP_PORT = "587"
npm start
```

**Windows (Command Prompt):**
```cmd
set SMTP_USER=your-email@gmail.com
set SMTP_PASS=your-app-password
set SMTP_HOST=smtp.gmail.com
set SMTP_PORT=587
npm start
```

**Mac/Linux:**
```bash
export SMTP_USER="your-email@gmail.com"
export SMTP_PASS="your-app-password"
export SMTP_HOST="smtp.gmail.com"
export SMTP_PORT="587"
npm start
```

### Option B: Using Another Email Provider

For Outlook, Yahoo, or other providers, use their SMTP settings:

**Outlook:**
- SMTP_HOST: smtp-mail.outlook.com
- SMTP_PORT: 587

**Yahoo:**
- SMTP_HOST: smtp.mail.yahoo.com
- SMTP_PORT: 587

## 3. Add Your Email in Admin Settings

1. Start the server with the environment variables set
2. Log into the admin panel
3. Go to **Settings**
4. In the "📧 Email Notifications" section, enter your email address
5. Click "Save Email"

## 4. Test

Create a test order, reservation, or review. You should receive an email notification within seconds!

## Troubleshooting

- **No email received?** Check the server logs for any errors
- **Authentication failed?** Double-check your SMTP credentials
- **Gmail blocking?** Allow "Less secure apps" or use App Passwords (recommended)
- **Email not saved?** Make sure you're logged in as admin and the email field is valid

## Security Note

Never commit environment variables to git. For production, consider using a `.env` file with a proper dotenv package.
