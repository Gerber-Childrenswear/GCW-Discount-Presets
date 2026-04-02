import {
  Banner,
  BlockStack,
  Text,
  reactExtension,
  useDiscountAllocations,
} from '@shopify/ui-extensions-react/checkout';

export default reactExtension('purchase.checkout.block.render', () => <App />);

function App() {
  const allocations = useDiscountAllocations();

  if (!allocations || allocations.length === 0) {
    return null;
  }

  // De-duplicate by title (same discount applied to multiple lines)
  const seen = new Set();
  const unique = allocations.filter((a) => {
    const key = a.title || a.code || '';
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length === 0) {
    return null;
  }

  return (
    <BlockStack spacing="tight">
      {unique.map((alloc, i) => (
        <Banner key={i} status="success" title={alloc.title || 'Discount applied'}>
          {alloc.code ? (
            <Text>Code: {alloc.code}</Text>
          ) : null}
        </Banner>
      ))}
    </BlockStack>
  );
}
