use serde::Deserialize;
use shopify_function::prelude::*;
use shopify_function::Result;
use std::collections::HashSet;

const DEFAULT_DISCOUNT_PERCENT: f64 = 25.0;
const DEFAULT_MESSAGE: &str = "Extra 25% Off Applied!";

// Tags queryable in input.graphql via hasTags() — configurable via included_tags / exclude_tags:
// discount, sale, clearance, markdown, promo,
// bundle, bogo, bxgy, gift,
// holiday, flash-sale, doorbuster, flag:doorbuster, outlet, overstock,
// member, vip, loyalty,
// baby, toddler, kids, infant, newborn, boys, girls,
// nfl,
// preorder, backorder
//
// Hard-exclusion tags via hasAnyTag() (excludeCheck) — always skipped, not configurable:
// no discount, no discount:strict, final-sale, no-return, DOTW

#[typegen("./schema.graphql")]
pub mod schema {
    #[query("./input.graphql")]
    pub mod run {}
}

use schema::run::input::cart::lines::Merchandise;

#[shopify_function]
fn run(input: schema::run::Input) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    let config = read_config(&input);
    let percentage_value = clamp_percentage(config.percentage);

    if percentage_value <= 0.0 {
        return Ok(empty_result());
    }

    let filter = ProductFilter::from_config(&config);

    let targets: Vec<schema::ProductDiscountCandidateTarget> = input
        .cart()
        .lines()
        .iter()
        .filter_map(|line| {
            let pv = match line.merchandise() {
                Merchandise::ProductVariant(pv) => pv,
                _ => return None,
            };
            let product = pv.product();

            // Hard-exclusion fast path: hasAnyTag() covers
            // no discount, no discount:strict, final-sale, no-return, DOTW.
            // A single Boolean — no per-tag iteration needed.
            // Note: flag:doorbuster is NOT here — it is configurable via hasTags()
            // so doorbuster campaigns can target it via included_tags.
            if *product.exclude_check() {
                return None;
            }

            // Only build the tag set if tag filtering is configured — avoids a
            // heap allocation per cart line for discounts that apply to all products.
            let product_tags: HashSet<String> = if filter.needs_tag_check() {
                product
                    .tag_checks()
                    .iter()
                    .filter(|tc| *tc.has_tag())
                    .map(|tc| tc.tag().to_ascii_lowercase())
                    .collect()
            } else {
                HashSet::new()
            };

            if !filter.should_include(
                product.id(),
                *product.is_gift_card(),
                product.product_type().map(|s| s.as_str()),
                product.vendor().map(|s| s.as_str()),
                &product_tags,
            ) {
                None
            } else {
                Some(schema::ProductDiscountCandidateTarget::CartLine(
                    schema::CartLineTarget {
                        id: line.id().to_string(),
                        quantity: None,
                    },
                ))
            }
        })
        .collect();

    if targets.is_empty() {
        return Ok(empty_result());
    }

    let message = config
        .message
        .unwrap_or_else(|| default_message(percentage_value));

    let candidate = schema::ProductDiscountCandidate {
        associated_discount_code: None,
        message: Some(message),
        targets,
        value: schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
            value: Decimal::from(percentage_value),
        }),
    };

    Ok(schema::CartLinesDiscountsGenerateRunResult {
        operations: vec![schema::CartOperation::ProductDiscountsAdd(
            schema::ProductDiscountsAddOperation {
                candidates: vec![candidate],
                selection_strategy: schema::ProductDiscountSelectionStrategy::First,
            },
        )],
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn empty_result() -> schema::CartLinesDiscountsGenerateRunResult {
    schema::CartLinesDiscountsGenerateRunResult { operations: vec![] }
}

fn clamp_percentage(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        DEFAULT_DISCOUNT_PERCENT
    }
}

fn default_message(percentage: f64) -> String {
    if (percentage - DEFAULT_DISCOUNT_PERCENT).abs() < f64::EPSILON {
        DEFAULT_MESSAGE.to_string()
    } else {
        format!("Extra {}% Off Applied!", percentage)
    }
}

fn normalize(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn normalize_set(values: &[String]) -> HashSet<String> {
    values
        .iter()
        .map(String::as_str)
        .map(normalize)
        .filter(|v| !v.is_empty())
        .collect()
}

fn id_set(values: &[String]) -> HashSet<String> {
    values
        .iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect()
}

/// Parse a comma-separated string into a normalized HashSet.
fn csv_to_set(csv: &str) -> HashSet<String> {
    csv.split(',')
        .map(normalize)
        .filter(|t| !t.is_empty())
        .collect()
}

fn read_config(input: &schema::run::Input) -> DiscountConfig {
    // discount().metafield() returns Option (metafield is nullable in schema)
    // metafield.value() returns &str (String! non-nullable)
    input
        .discount()
        .metafield()
        .and_then(|metafield| serde_json::from_str::<DiscountConfig>(metafield.value()).ok())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Config — deserialized from the discount node's metafield JSON
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(default)]
struct DiscountConfig {
    percentage: f64,
    message: Option<String>,
    exclude_gift_cards: bool,

    // Inclusion: if non-empty, ONLY products with at least one of these tags
    // receive the discount.
    #[serde(default)]
    included_tags: Vec<String>,

    // Exclusion lists
    #[serde(default)]
    exclude_tags: Vec<String>,
    #[serde(default)]
    exclude_product_types: Vec<String>,
    #[serde(default)]
    exclude_vendors: Vec<String>,
    #[serde(default)]
    included_vendors: Vec<String>,
    #[serde(default)]
    exclude_product_ids: Vec<String>,

    // Legacy: comma-separated string variants sent by older JS code
    #[serde(default)]
    included_tags_csv: Option<String>,
    #[serde(default)]
    excluded_tags_csv: Option<String>,
}

impl Default for DiscountConfig {
    fn default() -> Self {
        Self {
            percentage: DEFAULT_DISCOUNT_PERCENT,
            message: Some(DEFAULT_MESSAGE.to_string()),
            exclude_gift_cards: true,
            included_tags: Vec::new(),
            exclude_tags: Vec::new(),
            exclude_product_types: Vec::new(),
            exclude_vendors: Vec::new(),
            included_vendors: Vec::new(),
            exclude_product_ids: Vec::new(),
            included_tags_csv: None,
            excluded_tags_csv: None,
        }
    }
}

// ---------------------------------------------------------------------------
// ProductFilter — decides whether a product should receive the discount
// ---------------------------------------------------------------------------

struct ProductFilter {
    exclude_gift_cards: bool,
    included_tags: HashSet<String>,
    exclude_tags: HashSet<String>,
    product_types: HashSet<String>,
    vendors: HashSet<String>,
    included_vendors: HashSet<String>,
    product_ids: HashSet<String>,
}

impl ProductFilter {
    fn needs_tag_check(&self) -> bool {
        !self.exclude_tags.is_empty() || !self.included_tags.is_empty()
    }

    fn from_config(config: &DiscountConfig) -> Self {
        // Merge array + CSV sources for included tags
        let mut included = normalize_set(&config.included_tags);
        if let Some(csv) = &config.included_tags_csv {
            included.extend(csv_to_set(csv));
        }

        // Merge array + CSV sources for excluded tags
        let mut excluded = normalize_set(&config.exclude_tags);
        if let Some(csv) = &config.excluded_tags_csv {
            excluded.extend(csv_to_set(csv));
        }

        Self {
            exclude_gift_cards: config.exclude_gift_cards,
            included_tags: included,
            exclude_tags: excluded,
            product_types: normalize_set(&config.exclude_product_types),
            vendors: normalize_set(&config.exclude_vendors),
            included_vendors: normalize_set(&config.included_vendors),
            product_ids: id_set(&config.exclude_product_ids),
        }
    }

    /// Returns `true` when the product **should** receive a discount.
    fn should_include(
        &self,
        product_id: &str,
        is_gift_card: bool,
        product_type: Option<&str>,
        vendor: Option<&str>,
        product_tags: &HashSet<String>,
    ) -> bool {
        // --- Hard exclusions ---
        if self.product_ids.contains(product_id) {
            return false;
        }

        if self.exclude_gift_cards && is_gift_card {
            return false;
        }

        // Gift-card heuristic via product type
        if self.exclude_gift_cards {
            if let Some(pt) = product_type {
                let lower = pt.to_ascii_lowercase();
                if lower.contains("gift card") || lower.contains("giftcard") {
                    return false;
                }
            }
        }

        // Excluded product types
        if let Some(pt) = product_type {
            if self.product_types.contains(&normalize(pt)) {
                return false;
            }
        }

        // Excluded vendors
        if let Some(v) = vendor {
            if self.vendors.contains(&normalize(v)) {
                return false;
            }
        }

        // Included vendors — if non-empty, product vendor must match at least one
        if !self.included_vendors.is_empty() {
            match vendor {
                Some(v) if self.included_vendors.contains(&normalize(v)) => {}
                _ => return false,
            }
        }

        // Excluded tags — if the product has ANY excluded tag, skip it
        if !self.exclude_tags.is_empty() {
            for tag in product_tags {
                if self.exclude_tags.contains(tag) {
                    return false;
                }
            }
        }

        // --- Inclusion gate ---
        // When included_tags is non-empty the product must have at least one
        // matching tag to qualify (allowlist behaviour).
        if !self.included_tags.is_empty()
            && !product_tags.iter().any(|t| self.included_tags.contains(t))
        {
            return false;
        }

        true
    }
}

// ===========================================================================
// Tests
// ===========================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use shopify_function::{run_function_with_input, Result};

    fn make_tag_checks(tags: &[(&str, bool)]) -> serde_json::Value {
        serde_json::json!(tags
            .iter()
            .map(|(tag, has)| { serde_json::json!({ "hasTag": has, "tag": tag }) })
            .collect::<Vec<_>>())
    }

    fn default_tag_checks() -> serde_json::Value {
        let tags = [
            "discount",
            "sale",
            "clearance",
            "markdown",
            "promo",
            "special",
            "new",
            "featured",
            "bundle",
            "exclusive",
            "seasonal",
            "summer",
            "winter",
            "spring",
            "fall",
        ];
        make_tag_checks(&tags.iter().map(|t| (*t, false)).collect::<Vec<_>>())
    }

    fn tag_checks_with(active_tags: &[&str]) -> serde_json::Value {
        let all_tags = [
            "discount",
            "sale",
            "clearance",
            "markdown",
            "promo",
            "special",
            "new",
            "featured",
            "bundle",
            "exclusive",
            "seasonal",
            "summer",
            "winter",
            "spring",
            "fall",
        ];
        make_tag_checks(
            &all_tags
                .iter()
                .map(|t| (*t, active_tags.contains(t)))
                .collect::<Vec<_>>(),
        )
    }

    fn make_line(
        id: &str,
        qty: i32,
        product_id: &str,
        product_type: &str,
        is_gift_card: bool,
        vendor: &str,
        tag_checks: serde_json::Value,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "quantity": qty,
            "merchandise": {
                "__typename": "ProductVariant",
                "id": format!("gid://shopify/ProductVariant/{}", id),
                "product": {
                    "id": product_id,
                    "productType": product_type,
                    "isGiftCard": is_gift_card,
                    "vendor": vendor,
                    "excludeCheck": false,
                    "tagChecks": tag_checks
                }
            }
        })
    }

    fn make_input(config_json: Option<&str>, lines: Vec<serde_json::Value>) -> String {
        let metafield = config_json.map(|c| serde_json::json!({ "value": c }));
        serde_json::json!({
            "discount": {
                "metafield": metafield
            },
            "cart": {
                "lines": lines
            }
        })
        .to_string()
    }

    #[test]
    fn test_empty_cart() -> Result<()> {
        let input = make_input(Some(r#"{"percentage":25}"#), vec![]);
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_basic_discount() -> Result<()> {
        let input = make_input(
            Some(r#"{"percentage":25,"included_tags":[]}"#),
            vec![make_line(
                "1",
                2,
                "gid://shopify/Product/100",
                "Onesie",
                false,
                "Gerber",
                default_tag_checks(),
            )],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        Ok(())
    }

    #[test]
    fn test_gift_card_excluded_by_flag() -> Result<()> {
        let input = make_input(
            Some(r#"{"percentage":25,"exclude_gift_cards":true}"#),
            vec![make_line(
                "1",
                1,
                "gid://shopify/Product/100",
                "Gift Card",
                true,
                "Gerber",
                default_tag_checks(),
            )],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_gift_card_heuristic_product_type() -> Result<()> {
        let input = make_input(
            Some(r#"{"percentage":25,"exclude_gift_cards":true}"#),
            vec![make_line(
                "1",
                1,
                "gid://shopify/Product/100",
                "Gift Card",
                false,
                "Gerber",
                default_tag_checks(),
            )],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_included_tags_filter() -> Result<()> {
        let input = make_input(
            Some(r#"{"percentage":25,"included_tags":["sale"]}"#),
            vec![
                make_line(
                    "1",
                    1,
                    "gid://shopify/Product/100",
                    "Onesie",
                    false,
                    "Gerber",
                    tag_checks_with(&["sale"]),
                ),
                make_line(
                    "2",
                    1,
                    "gid://shopify/Product/200",
                    "Onesie",
                    false,
                    "Gerber",
                    default_tag_checks(),
                ),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            assert_eq!(op.candidates[0].targets.len(), 1);
        } else {
            panic!("Expected ProductDiscountsAdd");
        }
        Ok(())
    }

    #[test]
    fn test_excluded_tags() -> Result<()> {
        let input = make_input(
            Some(r#"{"percentage":25,"exclude_tags":["clearance"]}"#),
            vec![
                make_line(
                    "1",
                    1,
                    "gid://shopify/Product/100",
                    "Onesie",
                    false,
                    "Gerber",
                    tag_checks_with(&["clearance"]),
                ),
                make_line(
                    "2",
                    1,
                    "gid://shopify/Product/200",
                    "Onesie",
                    false,
                    "Gerber",
                    default_tag_checks(),
                ),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            assert_eq!(op.candidates[0].targets.len(), 1);
        }
        Ok(())
    }

    #[test]
    fn test_excluded_vendor() -> Result<()> {
        let input = make_input(
            Some(r#"{"percentage":25,"exclude_vendors":["BadVendor"]}"#),
            vec![
                make_line(
                    "1",
                    1,
                    "gid://shopify/Product/100",
                    "Onesie",
                    false,
                    "BadVendor",
                    default_tag_checks(),
                ),
                make_line(
                    "2",
                    1,
                    "gid://shopify/Product/200",
                    "Onesie",
                    false,
                    "Gerber",
                    default_tag_checks(),
                ),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            assert_eq!(op.candidates[0].targets.len(), 1);
        }
        Ok(())
    }

    #[test]
    fn test_included_vendor_whitelist() -> Result<()> {
        let input = make_input(
            Some(r#"{"percentage":25,"included_vendors":["Gerber"]}"#),
            vec![
                make_line(
                    "1",
                    1,
                    "gid://shopify/Product/100",
                    "Onesie",
                    false,
                    "OtherVendor",
                    default_tag_checks(),
                ),
                make_line(
                    "2",
                    1,
                    "gid://shopify/Product/200",
                    "Onesie",
                    false,
                    "Gerber",
                    default_tag_checks(),
                ),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            assert_eq!(op.candidates[0].targets.len(), 1);
        }
        Ok(())
    }

    #[test]
    fn test_zero_percentage_returns_empty() -> Result<()> {
        let input = make_input(
            Some(r#"{"percentage":0}"#),
            vec![make_line(
                "1",
                1,
                "gid://shopify/Product/100",
                "Onesie",
                false,
                "Gerber",
                default_tag_checks(),
            )],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_missing_metafield_uses_defaults() -> Result<()> {
        let input = make_input(
            None,
            vec![make_line(
                "1",
                1,
                "gid://shopify/Product/100",
                "Onesie",
                false,
                "Gerber",
                default_tag_checks(),
            )],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        Ok(())
    }

    #[test]
    fn test_percentage_clamped_to_100() -> Result<()> {
        let input = make_input(
            Some(r#"{"percentage":150}"#),
            vec![make_line(
                "1",
                1,
                "gid://shopify/Product/100",
                "Onesie",
                false,
                "Gerber",
                default_tag_checks(),
            )],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        Ok(())
    }

    #[test]
    fn test_excluded_product_id() -> Result<()> {
        let input = make_input(
            Some(r#"{"percentage":25,"exclude_product_ids":["gid://shopify/Product/100"]}"#),
            vec![
                make_line(
                    "1",
                    1,
                    "gid://shopify/Product/100",
                    "Onesie",
                    false,
                    "Gerber",
                    default_tag_checks(),
                ),
                make_line(
                    "2",
                    1,
                    "gid://shopify/Product/200",
                    "Onesie",
                    false,
                    "Gerber",
                    default_tag_checks(),
                ),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            assert_eq!(op.candidates[0].targets.len(), 1);
        }
        Ok(())
    }

    #[test]
    fn test_csv_included_tags_legacy() -> Result<()> {
        let input = make_input(
            Some(r#"{"percentage":25,"included_tags_csv":"sale,discount"}"#),
            vec![
                make_line(
                    "1",
                    1,
                    "gid://shopify/Product/100",
                    "Onesie",
                    false,
                    "Gerber",
                    tag_checks_with(&["sale"]),
                ),
                make_line(
                    "2",
                    1,
                    "gid://shopify/Product/200",
                    "Onesie",
                    false,
                    "Gerber",
                    default_tag_checks(),
                ),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            assert_eq!(op.candidates[0].targets.len(), 1);
        }
        Ok(())
    }

    #[test]
    fn test_all_gift_cards_returns_empty() -> Result<()> {
        let input = make_input(
            Some(r#"{"percentage":25}"#),
            vec![
                make_line(
                    "1",
                    1,
                    "gid://shopify/Product/100",
                    "Gift Card",
                    true,
                    "Gerber",
                    default_tag_checks(),
                ),
                make_line(
                    "2",
                    1,
                    "gid://shopify/Product/200",
                    "giftcard",
                    true,
                    "Gerber",
                    default_tag_checks(),
                ),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_hard_exclusion_tag_excludes_product() -> Result<()> {
        // A product with excludeCheck=true (e.g. tagged flag:doorbuster or
        // no discount) must be skipped regardless of other config.
        let line_hard_excluded = serde_json::json!({
            "id": "gid://shopify/CartLine/1",
            "quantity": 1,
            "merchandise": {
                "__typename": "ProductVariant",
                "id": "gid://shopify/ProductVariant/111",
                "product": {
                    "id": "gid://shopify/Product/100",
                    "productType": "Onesie",
                    "isGiftCard": false,
                    "vendor": "Gerber",
                    "excludeCheck": true,
                    "tagChecks": []
                }
            }
        });
        let input = make_input(
            Some(r#"{"percentage":25}"#),
            vec![line_hard_excluded],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty(), "hard-excluded product should not receive a discount");
        Ok(())
    }
}
