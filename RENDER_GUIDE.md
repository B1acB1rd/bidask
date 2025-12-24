# ☁️ Easy Deployment Guide (Render)

This is much easier than AWS. You will connect your code to Render, and it will handle the rest.

## Step 1: Put Code on GitHub (Required)
Render needs to access your code.
1.  Create a **GitHub Account** (if you don't have one).
2.  Create a **New Repository** (name it `solana-bot`, maximize "Private" if you want).
3.  Upload your files to this repository.
    *   *Easiest way:* Use the "Upload files" button on GitHub website and drag your `bidask` folder content (excluding `node_modules`).
    *   *Better way:* Use Git commands in your terminal:
        ```bash
        git init
        git add .
        git commit -m "Initial commit"
        # Run the commands GitHub gives you (git remote add origin...)
        git push -u origin main
        ```

## Step 2: Setup on Render.com
1.  Sign up at [render.com](https://render.com).
2.  Click **"New +"** -> **"Web Service"**.
3.  Connect your GitHub repository.
4.  **Settings:**
    *   **Name:** `solana-bot`
    *   **Region:** Choose closest to you (e.g. Oregon).
    *   **Branch:** `main`
    *   **Runtime:** `Node`
    *   **Build Command:** `npm install && npm run build`
    *   **Start Command:** `npm start`
    *   **Instance Type:** **Free** (select the Free tier).

## Step 3: Add Your Secrets (Super Important!)
In the Render setup page (or under "Environment" tab later):
1.  Scroll to **"Environment Variables"**.
2.  Add the keys from your `.env` file:
    *   `WALLET_PRIVATE_KEY` = `(paste your key)`
    *   `TELEGRAM_BOT_TOKEN` = `(paste token)`
    *   `TELEGRAM_CHAT_ID` = `(paste id)`
    *   `NETWORK` = `devnet`
    *   `PRICE_REFRESH_MS` = `5000`

## Step 4: Deploy & Keep Alive
1.  Click **"Create Web Service"**.
2.  Render will deploy and print logs.
3.  **Prevent Sleeping:** The Free Tier sleeps after 15 mins of inactivity.
    *   Use a free service like **UptimeRobot** or **Cron-job.org**.
    *   Create a monitor that pings your Render URL (e.g., `https://solana-bot.onrender.com/`) every 5 minutes.
    *   This keeps your bot running 24/7 for free!
