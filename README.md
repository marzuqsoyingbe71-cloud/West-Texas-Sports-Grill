# West Texas Sports Grill

## Local Stripe/PayPal webhook testing

### 1. Install dependencies

```bash
cd c:\Users\user\Documents\westnew
npm install
```

### 2. Create a local env file

Copy `.env.example` to `.env` and fill in your secret keys:

```bash
copy .env.example .env
```

Then edit `.env` and set:
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_WEBHOOK_ID`
- optional `BASE_ORIGIN` (defaults to `http://localhost:3000`)

### 3. Start the app with env vars

In PowerShell:

```powershell
$env:STRIPE_SECRET_KEY = 'sk_test_...'
$env:STRIPE_WEBHOOK_SECRET = 'whsec_...'
$env:PAYPAL_CLIENT_ID = 'your-paypal-client-id'
$env:PAYPAL_CLIENT_SECRET = 'your-paypal-client-secret'
$env:PAYPAL_WEBHOOK_ID = 'your-paypal-webhook-id'
$env:BASE_ORIGIN = 'http://localhost:3000'
npm start
```

If you prefer `.env` handling, use a tool like `cross-env` or load env vars before `node server.js`.

### 4. Install and run ngrok

Download and install [ngrok](https://ngrok.com/), then run:

```bash
ngrok http 3000
```

Copy the generated HTTPS URL, for example:

```text
https://abc123.ngrok.io
```

### 5. Configure webhook endpoints

#### Stripe

1. Open the Stripe Dashboard and go to Developers → Webhooks.
2. Click **+ Add endpoint**.
3. Enter the URL:

```text
https://<your-ngrok-id>.ngrok.io/api/payments/stripe/webhook
```

4. Choose event types:
   - `checkout.session.completed`
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed` (optional)
5. Save the endpoint.
6. Copy the webhook secret (`whsec_...`) and add it to `STRIPE_WEBHOOK_SECRET`.

#### PayPal

1. Go to the PayPal Developer Dashboard and open your app.
2. In the Webhooks section, click **Add Webhook**.
3. Use this URL:

```text
https://<your-ngrok-id>.ngrok.io/api/payments/paypal/webhook
```

4. Select event types:
   - `CHECKOUT.ORDER.APPROVED`
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.SALE.COMPLETED`
5. Save the webhook.
6. Copy the Webhook ID and add it to `PAYPAL_WEBHOOK_ID`.

### 6. Test the flow

1. Open the site at `http://localhost:3000`
2. Create a delivery order using Stripe or PayPal payment method
3. Complete checkout and return to the site
4. The app will poll order status and show tracking when payment is confirmed

### Notes

- Do not share secret keys publicly.
- `BASE_ORIGIN` should match the URL used for return URLs if you use a public host.
- If you need help with the webhook setup, I can guide you through Stripe and PayPal dashboard configuration.
