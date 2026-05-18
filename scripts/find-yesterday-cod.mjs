// Find yesterday's first COD order per store. Uses each shop's Session token.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SHOPS = [
  { domain: 'f51039.myshopify.com',    label: 'Urban Classics' },
  { domain: 'ys4n0u-ys.myshopify.com', label: 'Storico'        },
  { domain: '52j1ga-hz.myshopify.com', label: 'Classicoo'      },
  { domain: 'acmsuy-g0.myshopify.com', label: 'Trendsetters'   },
];

// Yesterday in IST (UTC+05:30)
const startIST = '2026-04-24T00:00:00+05:30';
const endIST   = '2026-04-25T00:00:00+05:30';

async function fetchFirstCod(shop, token) {
  const q = `
    query {
      orders(first: 10, sortKey: CREATED_AT,
             query: "created_at:>='${startIST}' created_at:<'${endIST}' financial_status:pending") {
        edges { node {
          name createdAt
          totalPriceSet { shopMoney { amount currencyCode } }
          paymentGatewayNames
          customer { firstName lastName }
          shippingAddress { phone city }
          phone
          tags
        } }
      }
    }`;
  const r = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const j = await r.json();
  const edges = j?.data?.orders?.edges || [];
  // Filter for COD: paymentGatewayNames contains "Cash on Delivery (COD)" OR similar
  const cod = edges.find(e => {
    const g = (e.node.paymentGatewayNames || []).join(',').toLowerCase();
    return g.includes('cash') || g.includes('cod') || (e.node.tags || []).some(t => t.toLowerCase() === 'cod');
  }) || edges[0]; // fall back to first pending
  return cod?.node || null;
}

(async () => {
  for (const s of SHOPS) {
    const sess = await prisma.session.findFirst({ where: { shop: s.domain } });
    if (!sess) { console.log(`${s.label.padEnd(15)} | NO SESSION`); continue; }
    try {
      const o = await fetchFirstCod(s.domain, sess.accessToken);
      if (!o) {
        console.log(`${s.label.padEnd(15)} | no pending orders 2026-04-24 IST`);
      } else {
        const name  = o.customer ? `${o.customer.firstName||''} ${o.customer.lastName||''}`.trim() : '';
        const phone = o.shippingAddress?.phone || o.phone || '';
        const total = o.totalPriceSet?.shopMoney?.amount || '?';
        const ccy   = o.totalPriceSet?.shopMoney?.currencyCode || '';
        const gw    = (o.paymentGatewayNames||[]).join('+') || '?';
        console.log(`${s.label.padEnd(15)} | ${o.name.padEnd(7)} | ${name.padEnd(22)} | ${phone.padEnd(15)} | ${total} ${ccy} | gw=${gw} | created=${o.createdAt}`);
      }
    } catch (e) {
      console.log(`${s.label.padEnd(15)} | ERROR: ${e.message}`);
    }
  }
  await prisma.$disconnect();
})();
