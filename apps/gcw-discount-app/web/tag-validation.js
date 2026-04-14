export const AVAILABLE_FUNCTION_TAGS = [
  'discount', 'sale', 'clearance', 'markdown', 'promo',
  'special', 'new', 'featured', 'bundle', 'exclusive',
  'seasonal', 'summer', 'winter', 'spring', 'fall',
  'holiday', 'bogo', 'bxgy', 'buy-one-get-one', 'gift',
  'bestseller', 'limited', 'outlet', 'overstock', 'doorbuster',
  'flash-sale', 'member', 'vip', 'loyalty', 'rewards',
  'baby', 'toddler', 'kids', 'infant', 'newborn',
  'boys', 'girls', 'unisex', 'organic', 'essentials',
  'sleepwear', 'onesies', 'bodysuits', 'sets', 'accessories',
  'final-sale', 'no-return', 'preorder', 'backorder', 'new-arrival',
  '25-off', '30-off', '40-off', '50-off', 'free-gift',
];

export const AVAILABLE_BXGY_TAGS = AVAILABLE_FUNCTION_TAGS;

export function validateTags(tags, allowedTags = AVAILABLE_FUNCTION_TAGS) {
  if (!Array.isArray(tags) || tags.length === 0) return { valid: true, invalid: [], warnings: [] };
  const allowed = new Set(allowedTags.map(t => t.toLowerCase()));
  const invalid = tags.filter(t => !allowed.has(t.toLowerCase().trim()));
  const warnings = invalid.map(t => `Tag "${t}" is not in the function's hasTags() list and will be ignored at runtime`);
  return { valid: invalid.length === 0, invalid, warnings };
}

export const AVAILABLE_FUNCTION_VENDORS = [
  'Babiators\u00ae', 'Baby Fanatic', 'binibi', 'Dallas Cowboys',
  'Gerber Childrenswear', 'Gerber\u00ae', 'Gerber\u00ae Kids',
  'Itzy Ritzy\u00ae', 'Just Born\u00ae', 'Mighty Goods',
  'modern moments\u2122 by Gerber\u00ae',
  'modern moments\u2122 x Harry Potter\u2122',
  'modern moments\u2122 x Where The Wild Things Are',
  'modern moments\u2122 x Wicked\u2122',
  'Moms on Call', 'Mud Pie', 'NBA\u00ae', 'NFL',
  'Onesies\u00ae Brand', 'WubbaNub\u00ae',
];
