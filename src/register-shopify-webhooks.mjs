/**
 * One-command Shopify webhook registration.
 *
 * Uses the offline session's access token (stored in the shared Session table
 * by the Shopify auth app) to subscribe orders/create to our endpoint.
 *
 * Usage:
 *   node src/register-shopify-webhooks.mjs <shop-domain>
 *   # or set SHOP_DOMAIN env var and run without args
 *
 * Example:
 *   node src/register-shopify-webhooks.mjs your-shop.myshopify.com
 *
 * Idempotent: if a matching webhook already exists at the same URL, it's
 * kept; only mismatched/missing subscriptions are created or updated.
 */

import pkg from '@prisma/client';
const { PrismaClient } = pkg;

const prisma = new PrismaClient();

const shop = (process.argv[2] || process.env.SHOP_DOMAIN || '').trim();
if (!shop) {
  console.error('Usage: node src/register-shopify-webhooks.mjs <shop-domain>');
  process.exit(1);
}

const WEBHOOK_BASE = process.env.COD_CONFIRM_WEBHOOK_BASE
  || 'https://shopify.example.com/ai-voice-agent';

const TARGET_URL = `${WEBHOOK_BASE}/webhook/shopify/orders-create`;
const TOPIC = 'ORDERS_CREATE';

console.log(`\nRegistering Shopify webhook:`);
console.log(`  Shop:   ${shop}`);
console.log(`  Topic:  ${TOPIC}`);
console.log(`  URL:    ${TARGET_URL}`);

async function graphql(shop, token, query, variables) {
  const resp = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const data = await resp.json();
  if (!resp.ok || data.errors) {
    throw new Error(`Shopify GraphQL: ${JSON.stringify(data.errors || data)}`);
  }
  return data.data;
}

async function main() {
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session) {
    throw new Error(
      `No offline session for ${shop}. Install the Shopify Custom App (via ` +
      `shopify.example.com auth hub) and grant read_orders + write_orders scope first.`
    );
  }
  console.log(`  Session: ${session.id} (scope: ${session.scope || '(none)'})`);

  // 1. List existing subscriptions
  const { webhookSubscriptions } = await graphql(shop, session.accessToken, `{
    webhookSubscriptions(first: 250, topics: [${TOPIC}]) {
      edges { node { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
    }
  }`);
  const existing = webhookSubscriptions.edges.map(e => e.node);
  const match = existing.find(n => n.endpoint?.callbackUrl === TARGET_URL);

  if (match) {
    console.log(`\n✓ Webhook already registered: ${match.id}`);
    console.log(`  Nothing to do.\n`);
    return;
  }

  // 2. If there's an existing orders/create subscription pointing elsewhere,
  //    leave it alone — the store may have other reasons for it. We just add
  //    ours alongside.
  if (existing.length) {
    console.log(`\n  ${existing.length} existing ${TOPIC} subscription(s) found (different URLs). Adding ours alongside.`);
    existing.forEach(n => console.log(`    - ${n.id} → ${n.endpoint?.callbackUrl}`));
  }

  // 3. Create ours
  const create = await graphql(shop, session.accessToken, `
    mutation($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription { id topic endpoint { ... on WebhookHttpEndpoint { callbackUrl } } }
        userErrors { field message }
      }
    }`,
    {
      topic: TOPIC,
      webhookSubscription: {
        callbackUrl: TARGET_URL,
        format: 'JSON',
      },
    });

  const errors = create.webhookSubscriptionCreate.userErrors;
  if (errors?.length) {
    throw new Error(`Create failed: ${JSON.stringify(errors)}`);
  }
  const sub = create.webhookSubscriptionCreate.webhookSubscription;
  console.log(`\n✓ Created: ${sub.id}`);
  console.log(`  Topic: ${sub.topic}`);
  console.log(`  URL:   ${sub.endpoint?.callbackUrl}`);
  console.log(`\nIMPORTANT: Shopify will sign webhooks with the shared-secret from your Custom App's`);
  console.log(`           "API secret key". Ensure SHOPIFY_WEBHOOK_SECRET in .env matches that value,`);
  console.log(`           or the server will 401-reject every incoming webhook.\n`);
}

main()
  .catch(err => { console.error('\n✗ Registration failed:', err.message, '\n'); process.exit(1); })
  .finally(() => prisma.$disconnect());
