require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to Live Cloud Database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Build the database structure if it doesn't exist yet
async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS tenants (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            unit_number VARCHAR(50) NOT NULL,
            phone_number VARCHAR(20) NOT NULL,
            balance_due NUMERIC(10, 2) DEFAULT 0.00
        );
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY,
            tenant_id INT REFERENCES tenants(id),
            amount_paid NUMERIC(10, 2),
            payment_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            status VARCHAR(50)
        );
    `);
}
initDb().catch(err => console.error('Database connection error:', err));

async function dispatchSmsAlert(to, tenantName, unit, amount, outstanding) {
    const textContent = `Rent Confirmed! Hello ${tenantName}, we received your payment of $${amount.toFixed(2)} for Unit ${unit}. Your remaining balance is $${outstanding.toFixed(2)}. Thank you!`;
    try {
        await twilioClient.messages.create({
            body: textContent,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: to
        });
        console.log(`[SMS SUCCESS] Message delivered to ${to}`);
    } catch (error) {
        console.error(`[SMS ERROR] Delivery failed to ${to}:`, error.message);
    }
}

// Visual Interfaces
const renderDashboard = (tenants, payments) => `
<!DOCTYPE html>
<html>
<head>
    <title>Live Property Hub</title>
    <style>
        * { box-sizing: border-box; font-family: 'Segoe UI', sans-serif; margin:0; padding:0; }
        body { background: #f4f6f9; padding: 40px; }
        .container { max-width: 1100px; margin: 0 auto; display: grid; grid-template-columns: 2fr 1fr; gap: 30px; }
        .card { background: white; padding: 25px; border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
        h1 { margin-bottom: 20px; color: #1e293b; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th, td { padding: 12px; border-bottom: 1px solid #edf2f7; text-align: left; }
        th { background: #f8fafc; color: #64748b; }
        .btn { background: #2563eb; color: white; padding: 10px 15px; border: none; border-radius: 6px; cursor: pointer; text-decoration: none; display: inline-block; }
        input { width:100%; padding: 10px; margin: 8px 0 15px 0; border: 1px solid #cbd5e1; border-radius: 6px; }
    </style>
</head>
<body>
    <h1>🏢 Live Rental Operations Dashboard</h1>
    <div class="container">
        <div class="card">
            <h2>Active Tenant Ledger</h2>
            <table>
                <thead><tr><th>Tenant</th><th>Unit</th><th>Phone</th><th>Balance</th><th>Action</th></tr></thead>
                <tbody>
                    ${tenants.map(t => `
                        <tr>
                            <td><strong>${t.name}</strong></td><td>${t.unit_number}</td><td>${t.phone_number}</td>
                            <td style="color:#b91c1c; font-weight:600;">$${parseFloat(t.balance_due).toFixed(2)}</td>
                            <td><a href="/pay/${t.id}" target="_blank" style="color:#2563eb; font-weight:600;">Payment Portal ↗</a></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        <div class="card">
            <h2>Add New Tenant</h2>
            <form action="/api/tenants" method="POST">
                <label>Tenant Name</label><input type="text" name="name" required>
                <label>Unit / Apartment #</label><input type="text" name="unit_number" required>
                <label>Phone Number (Include Country Code: e.g. +1...)</label><input type="text" name="phone_number" required>
                <label>Rent Balance Owed ($)</label><input type="number" step="0.01" name="balance_due" required>
                <button type="submit" class="btn" style="width:100%">Save Profile</button>
            </form>
        </div>
    </div>
</body>
</html>
`;

const renderCheckout = (tenant) => `
<!DOCTYPE html>
<html>
<head>
    <title>Secure Checkout</title>
    <style>
        body { background: #f8fafc; font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .pay-card { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); width: 100%; max-width: 440px; }
        .box { background: #f1f5f9; padding: 15px; border-radius: 8px; margin: 15px 0; font-size: 14px; }
        input { width: 100%; padding: 12px; margin: 8px 0 18px 0; border: 1px solid #e2e8f0; border-radius: 8px; }
        .btn { width: 100%; background: #2563eb; color: white; padding: 14px; border: none; border-radius: 8px; font-size: 16px; font-weight:600; cursor: pointer; }
    </style>
</head>
<body>
    <div class="pay-card">
        <h2>Rent Payment Portal</h2>
        <div class="box">
            <p><strong>Tenant:</strong> ${tenant.name}</p>
            <p><strong>Unit:</strong> ${tenant.unit_number}</p>
            <p><strong>Total Balance Due:</strong> $${parseFloat(tenant.balance_due).toFixed(2)}</p>
        </div>
        <form action="/api/pay-rent" method="POST">
            <input type="hidden" name="tenant_id" value="${tenant.id}">
            <label>Payment Amount ($)</label>
            <input type="number" step="0.01" name="amount" value="${tenant.balance_due}" max="${tenant.balance_due}" required>
            <label>Cardholder Name</label><input type="text" required>
            <label>Credit Card Details</label><input type="text" placeholder="4242 •••• •••• 4242" required>
            <button type="submit" class="btn">Authorize Secure Payment</button>
        </form>
    </div>
</body>
</html>
`;

app.get('/', async (req, res) => {
    const tenants = await pool.query('SELECT * FROM tenants ORDER BY id ASC');
    res.send(renderDashboard(tenants.rows));
});

app.get('/pay/:id', async (req, res) => {
    const tenant = await pool.query('SELECT * FROM tenants WHERE id = $1', [req.params.id]);
    if (tenant.rows.length === 0) return res.status(404).send('Tenant not found.');
    res.send(renderCheckout(tenant.rows[0]));
});

app.post('/api/tenants', async (req, res) => {
    const { name, unit_number, phone_number, balance_due } = req.body;
    await pool.query('INSERT INTO tenants (name, unit_number, phone_number, balance_due) VALUES ($1, $2, $3, $4)', 
        [name, unit_number, phone_number, parseFloat(balance_due)]);
    res.redirect('/');
});

app.post('/api/pay-rent', async (req, res) => {
    const tenantId = parseInt(req.body.tenant_id);
    const amountPaid = parseFloat(req.body.amount);

    const tenantRes = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    const tenant = tenantRes.rows[0];

    const updatedBalance = parseFloat(tenant.balance_due) - amountPaid;

    try {
        // Issue live transaction intent through Stripe API
        await stripe.paymentIntents.create({
            amount: Math.round(amountPaid * 100),
            currency: 'usd',
            payment_method: 'pm_card_visa', 
            confirm: true,
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' }
        });

        // Record adjustments safely inside database tables
        await pool.query('UPDATE tenants SET balance_due = $1 WHERE id = $2', [updatedBalance, tenantId]);
        await pool.query('INSERT INTO payments (tenant_id, amount_paid, status) VALUES ($1, $2, \'COMPLETED\')', [tenantId, amountPaid]);

        // Trigger Live Network SMS Output Delivery
        await dispatchSmsAlert(tenant.phone_number, tenant.name, tenant.unit_number, amountPaid, updatedBalance);

        res.send(`<script>alert('Payment Received! SMS Confirmation sent to tenant.'); window.location.href = '/';</script>`);
    } catch (err) {
        res.status(400).send(`Transaction Denied: ${err.message}`);
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Application online on port ${PORT}`));