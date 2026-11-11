/**
 * Reading a store's order email (functions/api/_order-read.js)
 * Run: node --test tests/order-read.test.mjs
 *
 * Made-up stores' words and made-up names only (the repo is public). The
 * shapes follow what SOARD's real order mail looked like on Nov 9 2026:
 * Amazon's plain words through the orders@ group, Home Depot's Job / PO box
 * and UPS tracking, stores whose details are only in the HTML, one email per
 * package.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  storeOf, orderKind, trackingIn, carrierOfNumber, linksOf, productIdsIn, jobPoIn, shipToIn, orderNumberIn,
  expectedIn, markupRead, amazonRead, readOrderEmail, withAi, ORDER_SCHEMA,
} from '../functions/api/_order-read.js';

const NOV9 = Date.parse('2026-11-09T15:00:00Z'); // a Monday

test('the store, by the sender’s domain, a group’s copy included', () => {
  assert.equal(storeOf('Wayfair <account-updates@wayfair.com>').store, 'Wayfair');
  assert.equal(storeOf('"Crate & Barrel" <crateandbarrel@mail.crateandbarrel.com>').store, 'Crate & Barrel');
  assert.equal(storeOf('Amazon.com <shipment-tracking@amazon.com>').store, 'Amazon');
  assert.equal(storeOf('"Best Buy Notifications" <BestBuyInfo@emailinfo.bestbuy.com>').store, 'Best Buy');
  assert.deepEqual(storeOf('FedEx Freight <noreply@fedex.com>'), { store: null, carrier: 'FedEx', domain: 'fedex.com' }, 'a carrier, not a store');
  assert.equal(storeOf('"Mustard Made US" <hello@mustardmade.example>').store, 'Mustard Made US', 'a store not in the list goes by its name');
});

test('the kind of email, from real subjects', () => {
  const k = (s, p) => orderKind(s, p);
  assert.equal(k('Your order confirmation is 359672268'), 'order');
  assert.equal(k('Order confirmed. We\'re processing your order now!'), 'order');
  assert.equal(k('Thanks for your order!'), 'order');
  assert.equal(k('Your Etsy Purchase from PrintShop (4223036227)'), 'order');
  assert.equal(k('Shipped! Your order 359672268'), 'shipped');
  assert.equal(k('Order # WH51088760 Shipped: Part of your order is on its way, Pat!'), 'shipped');
  assert.equal(k('Track your package! Your order is on the way.'), 'shipped');
  assert.equal(k('Arriving soon! Your order 359672268'), 'shipped');
  assert.equal(k('Get ready! Your FedEx Freight Direct shipment is on its way to you'), 'shipped');
  assert.equal(k('Shipped: "Zinus 10 Inch Queen Foam..."'), 'shipped');
  assert.equal(k('📦 Your package is out for delivery. 📦'), 'out');
  assert.equal(k('Delivered: 2 "Countertop Support Bracket..."'), 'delivered');
  assert.equal(k('Your order has arrived! See what\'s inside.'), 'delivered');
  assert.equal(k('Order # WK40199038 Delivered: Let us know how we did!'), 'delivered', 'a delivery that also asks for a review');
  assert.equal(k('Your order is ready for pickup'), 'pickup');
  assert.equal(k('Your item has been delayed'), 'delayed');
  assert.equal(k('Your order has been cancelled'), 'cancelled');
  assert.equal(k('Your refund has been issued'), 'refund');
  assert.equal(k('Your return label is ready'), 'return');
  assert.equal(k('20% off everything this weekend'), null);
  assert.equal(k('Your cart misses you'), null);
  assert.equal(k('New arrivals for fall'), null);
  assert.equal(k('Zinus mattress', 'Your package was delivered! Delivered today'), 'delivered', 'the preview says it when the subject doesn’t');
});

test('tracking numbers: in the words, in Track links and in redirects; order and phone numbers never pass', () => {
  assert.deepEqual(trackingIn('Tracking: 1Z9620450392148623'), [{ carrier: 'UPS', number: '1Z9620450392148623' }]);
  assert.deepEqual(trackingIn('', ['https://www.fedex.com/fedextrack/?trknbr=771234567890']), [{ carrier: 'FedEx', number: '771234567890' }]);
  assert.deepEqual(trackingIn('', ['https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223344556677']), [{ carrier: 'USPS', number: '9400111899223344556677' }]);
  const wrapped = linksOf('<a href="https://click.store.example/r?url=https%3A%2F%2Fwww.ups.com%2Ftrack%3Ftracknum%3D1Z999AA10123456784&amp;id=7">Track</a>');
  assert.deepEqual(trackingIn('', wrapped), [{ carrier: 'UPS', number: '1Z999AA10123456784' }], 'a click-tracking redirect carries the real link');
  assert.deepEqual(trackingIn('Your Amazon package TBA123456789012 is on its way'), [{ carrier: 'Amazon', number: 'TBA123456789012' }]);
  assert.deepEqual(trackingIn('Shipped with FedEx, tracking 771234567890 arriving Friday'), [{ carrier: 'FedEx', number: '771234567890' }]);
  assert.deepEqual(trackingIn('Order 359672268123 · Call 770-555-0100 · Order # 111-6380839-2949054'), [], 'no carrier beside a long number');
  assert.equal(carrierOfNumber('1Z9620450392148623'), 'UPS');
  assert.equal(carrierOfNumber('12345'), null);
  const twice = trackingIn('1Z9620450392148623', ['https://www.ups.com/track?tracknum=1Z9620450392148623']);
  assert.equal(twice.length, 1, 'each number once');
});

test('product ids from links: Amazon, Wayfair, Home Depot', () => {
  const ids = productIdsIn([
    'https://www.amazon.com/dp/B07ABCDEF1?ref=x',
    'https://www.wayfair.com/home-improvement/pdp/ebern-designs-36-wall-vanity-w118123869.html',
    'https://www.homedepot.com/p/Some-Faucet/312345678',
  ]);
  assert.deepEqual(ids.sort(), ['amazon:B07ABCDEF1', 'homedepot:312345678', 'wayfair:w118123869']);
});

test('the Job / PO box, the Office ship-to, the order number', () => {
  const hd = 'Deliver to Pat Lee: 250 Hembree Park Dr, Roswell, GA 30076 Job / PO Number: Rowan Customer Phone Number: 770-555-0100 Delivery NOV 16 Est';
  assert.equal(jobPoIn(hd), 'Rowan');
  assert.equal(jobPoIn('PO Number: Rowan Smith\nShipping'), 'Rowan Smith');
  assert.equal(jobPoIn('PO #: N/A'), null);
  assert.equal(jobPoIn('Nothing typed here'), null);
  assert.equal(shipToIn(hd), 'office');
  assert.equal(shipToIn('Sunshine - ROSWELL, GA - On behalf of the charity'), 'office', 'Amazon Business writes the Office this way');
  assert.equal(shipToIn('Shipping to: 12 Oak Lane, Marietta GA'), 'elsewhere');
  assert.equal(shipToIn('Thanks for shopping with us'), null);
  assert.equal(orderNumberIn('', 'Your order confirmation is 359672268'), '359672268');
  assert.equal(orderNumberIn('Order # WH51088760 Order Date: Nov 6'), 'WH51088760');
  assert.equal(orderNumberIn('Order # 111-6380839-2949054 Track package'), '111-6380839-2949054');
  assert.equal(orderNumberIn('Order now and save'), null);
});

test('the expected day: a date, a weekday, tomorrow', () => {
  assert.equal(expectedIn('Delivery NOV 16 Est', NOV9), '2026-11-16');
  assert.equal(expectedIn('Arriving Thursday', NOV9), '2026-11-12');
  assert.equal(expectedIn('Estimated delivery: 11/20', NOV9), '2026-11-20');
  assert.equal(expectedIn('Arriving tomorrow', NOV9), '2026-11-10');
  assert.equal(expectedIn('Estimated delivery Jan 4', Date.parse('2026-12-28T15:00:00Z')), '2027-01-04', 'January seen in late December is next year');
  assert.equal(expectedIn('Thanks for your order', NOV9), null);
});

test('a store’s own order markup (schema.org) is read first', () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'http://schema.org', '@type': 'ParcelDelivery',
    trackingNumber: '1Z999AA10123456784', carrier: { '@type': 'Organization', name: 'UPS' }, expectedArrivalUntil: '2026-11-14T23:00:00-05:00',
    deliveryAddress: { '@type': 'PostalAddress', streetAddress: '250 Hembree Park Dr' },
    partOfOrder: { '@type': 'Order', orderNumber: 'A-1001', orderedItem: [{ '@type': 'OrderItem', orderQuantity: 2, orderedItem: { '@type': 'Product', name: 'Brass Wall Sconce', sku: 'SC-22' }, price: '149.00' }] },
  })}</script></head><body>Your order shipped</body></html>`;
  const r = markupRead(html);
  assert.equal(r.orderNumber, 'A-1001');
  assert.deepEqual(r.items, [{ name: 'Brass Wall Sconce', sku: 'SC-22', quantity: 2, cents: 14900 }]);
  assert.deepEqual(r.tracking, [{ carrier: 'UPS', number: '1Z999AA10123456784' }]);
  assert.equal(r.expected, '2026-11-14');
  assert.equal(r.shipTo, 'office');
  assert.equal(markupRead('<p>no markup</p>'), null);
  assert.equal(markupRead('<script type="application/ld+json">{broken</script>'), null, 'a broken block is skipped');
});

test('Amazon’s plain words: items, quantity, price, order number', () => {
  const text = 'Your package was shipped! Arriving Thursday Sunshine - ROSWELL, GA - On behalf of the charity Order # 111-6380839-2949054 Track package * Foam Mattress, Queen, Medium Feel Quantity: 1 271.75 USD * Picture Frames 12x12, Black Quantity: 2 Total 292.81 USD';
  const r = amazonRead(text);
  assert.equal(r.orderNumber, '111-6380839-2949054');
  assert.deepEqual(r.items, [
    { name: 'Foam Mattress, Queen, Medium Feel', sku: null, quantity: 1, cents: 27175 },
    { name: 'Picture Frames 12x12, Black', sku: null, quantity: 2, cents: null },
  ]);
});

test('a whole email: Amazon through the orders@ group, read without the AI', () => {
  const r = readOrderEmail({
    subject: 'Shipped: "Foam Mattress, Queen..."', from: 'Amazon.com <shipment-tracking@amazon.com>', sentAt: NOV9,
    text: 'Your package was shipped! Arriving Thursday Sunshine - ROSWELL, GA Order # 111-6380839-2949054 * Foam Mattress, Queen Quantity: 1 271.75 USD',
  });
  assert.equal(r.kind, 'shipped');
  assert.equal(r.store, 'Amazon');
  assert.equal(r.source, 'amazon');
  assert.equal(r.items.length, 1);
  assert.equal(r.shipTo, 'office');
  assert.equal(r.expected, '2026-11-12');
  assert.equal(r.needsAi, false);
});

test('a whole email: Home Depot’s shipped email gives the kid, the Office and UPS; its items need the AI', () => {
  const html = '<table><tr><td>Order # WH51088760</td></tr><tr><td>Deliver to Pat Lee: 250 Hembree Park Dr, Roswell, GA 30076</td></tr><tr><td>Job / PO Number: Rowan</td><td>Customer Phone Number: 770-555-0100</td></tr><tr><td>Delivery NOV 16 Est</td></tr><tr><td><a href="https://www.ups.com/track?loc=en_US&amp;tracknum=1Z9620450392148623">Track</a></td></tr></table>';
  const r = readOrderEmail({ subject: 'Order # WH51088760 Shipped: Part of your order is on its way, Pat!', from: '"\'The Home Depot\' via orders" <orders@soardcharity.com>', html, sentAt: NOV9 });
  assert.equal(r.kind, 'shipped');
  assert.equal(r.jobPo, 'Rowan');
  assert.equal(r.shipTo, 'office');
  assert.equal(r.orderNumber, 'WH51088760');
  assert.deepEqual(r.tracking, [{ carrier: 'UPS', number: '1Z9620450392148623' }]);
  assert.equal(r.expected, '2026-11-16');
  assert.equal(r.needsAi, true, 'no items in its words');
});

test('a carrier’s notice never asks the AI for items; a refund may have none', () => {
  assert.equal(readOrderEmail({ subject: 'Your FedEx shipment is on its way', from: 'FedEx <noreply@fedex.com>', text: 'FedEx tracking 771234567890' }).needsAi, false);
  assert.equal(readOrderEmail({ subject: 'Your refund has been issued', from: 'Shop <hi@shop.example>' }).needsAi, false);
});

test('the AI fills only what the rules left empty, and its made-up tracking numbers are dropped', () => {
  const rules = readOrderEmail({ subject: 'Shipped! Your order 359672268', from: 'Crate & Barrel <hi@crateandbarrel.com>', html: '<a href="https://www.ups.com/track?tracknum=1Z9620450392148623">Track</a>', sentAt: NOV9 });
  assert.equal(rules.needsAi, true);
  const r = withAi(rules, {
    kind: 'shipped', orderNumber: '999', items: [{ name: 'Oak Bunk Bed', sku: '123-456', quantity: 1, price: '$899.00' }, { name: '', sku: '', quantity: 1, price: '' }],
    trackingNumbers: ['1Z9620450392148623', 'ORDER359672268'], expected: '2026-11-18', shipTo: 'unknown', jobPo: '',
  });
  assert.equal(r.orderNumber, '359672268', 'the rules’ order number stays');
  assert.deepEqual(r.items, [{ name: 'Oak Bunk Bed', sku: '123-456', quantity: 1, cents: 89900 }], 'a nameless item is dropped');
  assert.equal(r.tracking.length, 1, 'the order number the AI called tracking is dropped');
  assert.equal(r.expected, '2026-11-18');
  assert.equal(r.shipTo, null, 'unknown stays unknown');
  assert.equal(r.source, 'ai');
  assert.equal(withAi(rules, null), rules, 'no answer, nothing changes');
});

test('the AI’s answer shape requires every field (Workers AI drops optional ones)', () => {
  assert.deepEqual(ORDER_SCHEMA.required.sort(), Object.keys(ORDER_SCHEMA.properties).sort());
  const item = ORDER_SCHEMA.properties.items.items;
  assert.deepEqual(item.required.sort(), Object.keys(item.properties).sort());
});

test('review fixes: kinds Amazon and others use', () => {
  assert.equal(orderKind('Ordered: "Oak Step Stool"'), 'order', 'Amazon’s confirmation');
  assert.equal(orderKind('We received your order!'), 'order');
  assert.equal(orderKind('Your order will be delivered tomorrow'), 'shipped', 'still on its way');
  assert.equal(orderKind('Your order is scheduled for delivery on Friday'), 'shipped');
});

test('review fixes: the expected day is Eastern and never made up', () => {
  // 8:30 PM Wednesday Eastern is already Thursday in UTC
  const wedEvening = Date.parse('2026-11-12T01:30:00Z');
  assert.equal(expectedIn('Arriving tomorrow', wedEvening), '2026-11-12');
  assert.equal(expectedIn('Arriving Thursday', wedEvening), '2026-11-12');
  assert.equal(expectedIn('Sold by Marketplace 2 Pack', NOV9), null, 'a word that starts like a month');
  assert.equal(expectedIn('Shipped by Decor 24 · Delivery hours vary', NOV9), null);
  assert.equal(expectedIn('Reach us by phone Monday through Friday', NOV9), null, 'a bare "by"');
  assert.equal(expectedIn('Delivery hours: we deliver Monday through Friday', NOV9), null, 'a weekday later in the line');
  assert.equal(expectedIn('Estimated delivery: November 16', NOV9), '2026-11-16');
});

test('review fixes: billed to the Office but shipped to a home is going to the home', () => {
  const t = 'Shipping address\nAna Sample\n12 Oak Lane\nMarietta, GA\nBilling address\nSOARD\n250 Hembree Park Dr\nRoswell, GA';
  assert.equal(shipToIn(t), 'elsewhere');
  assert.equal(shipToIn('Billing address: 250 Hembree Park Dr, Roswell, GA'), null, 'only a billing address: not said');
  assert.equal(shipToIn('Ship to: Pat Lee, 250 Hembree Park Dr, Roswell GA. Billing address: 12 Oak Lane'), 'office');
});

test('review fixes: an Order and its ParcelDelivery name each item once', () => {
  const item = { '@type': 'OrderItem', orderQuantity: 1, orderedItem: { '@type': 'Product', name: 'Lamp', sku: 'L-1' } };
  const html = `<script type="application/ld+json">${JSON.stringify([
    { '@type': 'Order', orderNumber: 'A-1', orderedItem: [item] },
    { '@type': 'ParcelDelivery', trackingNumber: '1Z999AA10123456784', partOfOrder: { '@type': 'Order', orderNumber: 'A-1', orderedItem: [item] } },
  ])}</script>`;
  assert.deepEqual(markupRead(html).items.map((i) => i.name), ['Lamp']);
});

test('review fixes: things that look like tracking numbers but aren’t', () => {
  assert.deepEqual(trackingIn('', ['https://www.ups.com/track?tracking=ENABLEDFORALL']), [], 'a parameter value without a carrier’s shape');
  assert.deepEqual(trackingIn('', ['https://click.store.example/x?qs=abc-1zA8bC9dE0fG1hI2jK-xyz']), [], 'the middle of a link’s code');
  assert.deepEqual(trackingIn('Your Target order 912345678901234 ships via FedEx'), [], 'a 15-digit order number near "FedEx"');
  assert.deepEqual(trackingIn('Tracking Number: 1Z9620450392148623'), [{ carrier: 'UPS', number: '1Z9620450392148623' }]);
});

test('review fixes: the Job / PO box and the order number misfiring', () => {
  assert.equal(jobPoIn('Your purchase order has shipped'), null);
  assert.equal(jobPoIn('Purchase order: Rowan'), 'Rowan');
  assert.equal(orderNumberIn('Questions about your order\n1-800-555-0100'), null, 'a phone number on the next line');
});

test('second review: out for delivery stays out; labels above their numbers; capital letters', () => {
  assert.equal(orderKind('UPS Update: Package Scheduled for Delivery Today'), 'out');
  assert.equal(orderKind('Your package will be delivered today'), 'out');
  assert.equal(orderKind('Your package was delivered today'), 'delivered');
  assert.equal(orderNumberIn('Order Number\nW123456789'), 'W123456789');
  assert.equal(orderNumberIn('Order Number\n\nW123456789'), 'W123456789', 'a table cell a blank line below');
  assert.equal(orderNumberIn('Questions about your order\n1-800-555-0100'), null);
  assert.deepEqual(trackingIn('TRACKING NUMBER: 1Z9620450392148623'), [{ carrier: 'UPS', number: '1Z9620450392148623' }]);
  assert.deepEqual(trackingIn('Tracking number: 1z9620450392148623x'), [], 'not as printed');
});

test('Nov 11: a UPS number written in lower case beside "UPS" (The Container Store) is read; a lower-case code elsewhere isn’t', async () => {
  const { trackingIn } = await import('../functions/api/_order-read.js');
  assert.deepEqual(trackingIn('Track This Package Arriving Thursday, November 5 UPS # 1z12d1r20300649284 2\' Elfa Closet Rod'), [{ carrier: 'UPS', number: '1Z12D1R20300649284' }]);
  assert.deepEqual(trackingIn('coupon code 1z12d1r20300649284 for 10% off'), [], 'no carrier named: not a tracking number');
});
