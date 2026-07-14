Here is the complete, step-by-step master guide to building your automated Google De-indexing Checker using Next.js and the Google Search Console API. 

You can follow this from start to finish to build the app locally.

---

# 🚀 Build an Automated Google Index Checker in Next.js

This system will run every day, loop through your website's pages, check their live index status via the Google Search Console API, bypass the 30-day UI delay, and alert you if a page drops out of the index.

## Step 1: Link your Bot to Google Search Console
Since you successfully generated your Google Cloud Service Account `.json` key, you must give that bot permission to read your website's data.

1. Open your downloaded `.json` file and copy the `"client_email"`.
2. Go to your **Google Search Console** dashboard.
3. Navigate to **Settings > Users and permissions > Add User**.
4. Paste the bot's email and give it **Restricted** access.

> **⚠️ Bug Alert:** If you get an *"Email not found"* error, use the legacy [Webmaster Central Verification Link](https://www.google.com/webmasters/verification/home), click your domain, scroll to the bottom, and click **Add an owner**. It will sync to GSC automatically.

## Step 2: Setup Next.js Environment Variables
Do not hardcode your JSON key into your code. Open your Next.js project and create or edit the `.env.local` file in the root directory.

```env
# .env.local

# Your bot's email address
GOOGLE_CLIENT_EMAIL="your-bot@your-project.iam.gserviceaccount.com"

# Copy the ENTIRE private key string exactly as it is in the JSON file (including \n)
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgk...[YOUR_FULL_KEY]...\n-----END PRIVATE KEY-----\n"

# A secret password you make up to secure your Cron Job
CRON_SECRET="my_super_secret_cron_password_123"
```

## Step 3: Database Setup (Prisma Example)
You need a database table to keep track of your URLs and when they were last checked. Here is a basic Prisma schema (using PostgreSQL, MySQL, or SQLite).

```prisma
// schema.prisma

model Page {
  id            String   @id @default(cuid())
  url           String   @unique
  isIndexed     Boolean  @default(true)
  coverageState String?  // Stores Google's exact status (e.g., "Crawled - currently not indexed")
  lastCheckedAt DateTime @default(now())
}
```
*Run `npx prisma db push` to sync your database.*

## Step 4: Install the Google Client Library
Open your terminal in your Next.js project root and install the official Google API package:

```bash
npm install googleapis
```

## Step 5: Write the API Core Logic
This is the engine of your app. It fetches a batch of URLs from your database, checks them against Google, strictly manages rate limits (to prevent 600 QPM errors), and updates the database.

Create a new file at: `app/api/cron/check-index/route.ts`

```typescript
import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function GET(request: Request) {
  // 1. Secure the Cron Job so random people can't trigger your API
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 2. Initialize Google Auth using your environment variables
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });

    const searchconsole = google.searchconsole({ version: 'v1', auth });

    // 🔴 IMPORTANT: This must EXACTLY match your GSC property name
    const siteUrl = 'https://yourwebsite.com/'; 

    // 3. Fetch URLs to check (Sort by oldest checked so we rotate fairly)
    // We limit to 50 per run to avoid serverless timeouts (Vercel has 10s-60s limits)
    const pages = await prisma.page.findMany({
      orderBy: { lastCheckedAt: 'asc' },
      take: 50 
    });

    const newlyDeindexedUrls = [];

    // 4. Loop through the URLs and inspect them
    for (const page of pages) {
      try {
        const response = await searchconsole.urlInspection.index.inspect({
          requestBody: {
            inspectionUrl: page.url,
            siteUrl: siteUrl,
            languageCode: 'en-US',
          },
        });

        const result = response.data.inspectionResult?.indexStatusResult;
        
        // PASS = Indexed, FAIL/NEUTRAL = Not Indexed
        const currentlyIndexed = result?.verdict === 'PASS';
        const coverageState = result?.coverageState || 'Unknown';

        // Detect if it JUST dropped from the index
        if (page.isIndexed && !currentlyIndexed) {
          newlyDeindexedUrls.push({ url: page.url, reason: coverageState });
        }

        // 5. Update Database with fresh data
        await prisma.page.update({
          where: { id: page.id },
          data: { 
            isIndexed: currentlyIndexed,
            coverageState: coverageState,
            lastCheckedAt: new Date()
          }
        });

        console.log(`Checked: ${page.url} | Status: ${coverageState}`);

      } catch (error: any) {
        if (error.code === 429) {
          console.warn('🚨 GSC Rate Limit Exceeded (2000/day limit hit). Stopping queue.');
          break; // Stop the loop for today
        }
        console.error(`Failed to check ${page.url}:`, error.message);
      }

      // 6. RATE LIMIT PROTECTION (Crucial!)
      // Google allows 600 requests per minute (10 per second). 
      // We sleep for 200ms between calls to stay completely safe.
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // 7. Trigger Alerts if pages were de-indexed
    if (newlyDeindexedUrls.length > 0) {
      // e.g., await sendDiscordWebhook(newlyDeindexedUrls);
      console.log('⚠️ DE-INDEXING ALERT!', newlyDeindexedUrls);
    }

    return NextResponse.json({ success: true, checked: pages.length });

  } catch (error: any) {
    console.error('Fatal Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

## Step 6: Test It Locally
You can test this script right now on your local machine before deploying.
1. Start your local server: `npm run dev`
2. Open a new terminal window and use `curl` to trigger the API with your secret password:
```bash
curl -H "Authorization: Bearer my_super_secret_cron_password_123" http://localhost:3000/api/cron/check-index
```
Watch your terminal logs! You should see it cleanly checking your pages one by one.

## Step 7: Automate Daily Execution (Vercel Cron)
To make this run completely hands-off in production, add a `vercel.json` file to the root of your project directory. This tells Vercel to ping your API route on a schedule.

```json
{
  "crons": [
    {
      "path": "/api/cron/check-index",
      "schedule": "0 * * * *"
    }
  ]
}
```
*Note: The schedule `"0 * * * *"` runs the script **once every hour**. Since the API code limits itself to checking 50 pages per run, this setup will safely check **1,200 pages a day**, completely keeping you under Google's 2,000 daily limit while bypassing Vercel timeout errors!*

### 🎉 You're Done!
You now have a fully automated, 100% free, real-time SEO monitoring system built directly into your Next.js app.