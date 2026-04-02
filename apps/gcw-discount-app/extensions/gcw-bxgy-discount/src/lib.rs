use serde::Deserialize;
use shopify_function::prelude::*;
use shopify_function::Result;
use std::collections::HashSet;

const DEFAULT_MESSAGE: &str = "Buy X Get Y discount applied!";

#[typegen("./schema.graphql")]
pub mod schema {
    #[query("./input.graphql")]
    pub mod run {}
}

use schema::run::input::cart::lines::Merchandise;

// ---------------------------------------------------------------------------
// Config — deserialized from the discount node's metafield JSON
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(default)]
struct BxgyConfig {
    /// Number of full-price items required to trigger the discount.
    buy_quantity: u32,
    /// Number of discounted items the customer gets.
    get_quantity: u32,
    /// Percentage off the "get" items (100 = free, 50 = half price).
    get_percentage: f64,
    /// Optional: only products with at least one of these tags qualify.
    /// If empty, all products qualify (except gift cards if excluded).
    #[serde(default)]
    qualifying_tags: Vec<String>,
    /// Message shown to the customer.
    message: Option<String>,
    /// Whether to exclude gift cards.
    exclude_gift_cards: bool,
    /// Whether to apply the discount to the cheapest items (true) or the
    /// most expensive items (false). Default: cheapest.
    discount_cheapest: bool,
}

impl Default for BxgyConfig {
    fn default() -> Self {
        Self {
            buy_quantity: 2,
            get_quantity: 1,
            get_percentage: 100.0, // free
            qualifying_tags: Vec::new(),
            message: Some(DEFAULT_MESSAGE.to_string()),
            exclude_gift_cards: true,
            discount_cheapest: true,
        }
    }
}

fn read_config(input: &schema::run::Input) -> BxgyConfig {
    input
        .discount()
        .metafield()
        .and_then(|mf| serde_json::from_str::<BxgyConfig>(mf.value()).ok())
        .unwrap_or_default()
}

fn clamp_percentage(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        100.0
    }
}

fn normalize(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn empty_result() -> schema::CartLinesDiscountsGenerateRunResult {
    schema::CartLinesDiscountsGenerateRunResult { operations: vec![] }
}

// ---------------------------------------------------------------------------
// Line item with price info for sorting
// ---------------------------------------------------------------------------
struct QualifyingLine {
    line_id: String,
    quantity: i32,
    unit_price: f64,
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[shopify_function]
fn run(input: schema::run::Input) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    let config = read_config(&input);

    let buy_qty = config.buy_quantity.max(1) as i32;
    let get_qty = config.get_quantity.max(1) as i32;
    let total_needed = buy_qty + get_qty;
    let percentage = clamp_percentage(config.get_percentage);

    if percentage <= 0.0 {
        return Ok(empty_result());
    }

    let qualifying_tags: HashSet<String> = config
        .qualifying_tags
        .iter()
        .map(String::as_str)
        .map(normalize)
        .filter(|t| !t.is_empty())
        .collect();

    // Collect qualifying lines with price info
    let mut qualifying_lines: Vec<QualifyingLine> = Vec::new();

    for line in input.cart().lines().iter() {
        let pv = match line.merchandise() {
            Merchandise::ProductVariant(pv) => pv,
            _ => continue,
        };
        let product = pv.product();

        // Exclude gift cards
        if config.exclude_gift_cards && *product.is_gift_card() {
            continue;
        }
        if config.exclude_gift_cards {
            if let Some(pt) = product.product_type() {
                let lower = pt.to_ascii_lowercase();
                if lower.contains("gift card") || lower.contains("giftcard") {
                    continue;
                }
            }
        }

        // Check qualifying tags (if any specified)
        if !qualifying_tags.is_empty() {
            let product_tags: HashSet<String> = product
                .tag_checks()
                .iter()
                .filter(|tc| *tc.has_tag())
                .map(|tc| tc.tag().to_ascii_lowercase())
                .collect();
            if !product_tags.iter().any(|t| qualifying_tags.contains(t)) {
                continue;
            }
        }

        let unit_price = line
            .cost()
            .amount_per_quantity()
            .amount()
            .to_string()
            .parse::<f64>()
            .unwrap_or(0.0);

        qualifying_lines.push(QualifyingLine {
            line_id: line.id().to_string(),
            quantity: *line.quantity(),
            unit_price,
        });
    }

    // Calculate total qualifying quantity
    let total_qualifying: i32 = qualifying_lines.iter().map(|l| l.quantity).sum();

    if total_qualifying < total_needed {
        return Ok(empty_result()); // Not enough items to trigger BXGY
    }

    // Sort by price: cheapest first or most expensive first
    if config.discount_cheapest {
        qualifying_lines.sort_by(|a, b| {
            a.unit_price
                .partial_cmp(&b.unit_price)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    } else {
        qualifying_lines.sort_by(|a, b| {
            b.unit_price
                .partial_cmp(&a.unit_price)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    // Determine how many complete BXGY sets we can form
    let sets = total_qualifying / total_needed;
    let mut discount_remaining = sets * get_qty;

    // Build targets: apply discount to the first `discount_remaining` items (sorted)
    let mut targets: Vec<schema::ProductDiscountCandidateTarget> = Vec::new();

    for line in &qualifying_lines {
        if discount_remaining <= 0 {
            break;
        }
        let apply_qty = line.quantity.min(discount_remaining);
        targets.push(schema::ProductDiscountCandidateTarget::CartLine(
            schema::CartLineTarget {
                id: line.line_id.clone(),
                quantity: Some(apply_qty),
            },
        ));
        discount_remaining -= apply_qty;
    }

    if targets.is_empty() {
        return Ok(empty_result());
    }

    let message = config.message.unwrap_or_else(|| {
        if (percentage - 100.0).abs() < f64::EPSILON {
            format!("Buy {} Get {} Free!", buy_qty, get_qty)
        } else {
            format!("Buy {} Get {} at {}% Off!", buy_qty, get_qty, percentage)
        }
    });

    let candidate = schema::ProductDiscountCandidate {
        associated_discount_code: None,
        message: Some(message),
        targets,
        value: schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
            value: Decimal::from(percentage),
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

// ===========================================================================
// Tests
// ===========================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use shopify_function::{run_function_with_input, Result};

    const BXGY_TAGS: &[&str] = &[
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
        "bxgy",
        "bogo",
        "buy-one-get-one",
    ];

    fn make_tag_checks(active: &[&str]) -> serde_json::Value {
        serde_json::json!(BXGY_TAGS
            .iter()
            .map(|t| { serde_json::json!({ "hasTag": active.contains(t), "tag": t }) })
            .collect::<Vec<_>>())
    }

    fn default_tag_checks() -> serde_json::Value {
        make_tag_checks(&[])
    }

    fn make_line(
        id: &str,
        qty: i32,
        unit_price: &str,
        is_gift_card: bool,
        product_type: &str,
        tags: serde_json::Value,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "quantity": qty,
            "cost": {
                "amountPerQuantity": { "amount": unit_price }
            },
            "merchandise": {
                "__typename": "ProductVariant",
                "id": format!("gid://shopify/ProductVariant/{}", id),
                "product": {
                    "id": format!("gid://shopify/Product/{}", id),
                    "productType": product_type,
                    "isGiftCard": is_gift_card,
                    "vendor": "Gerber",
                    "tagChecks": tags
                }
            }
        })
    }

    fn make_input(config_json: Option<&str>, lines: Vec<serde_json::Value>) -> String {
        let metafield = config_json.map(|c| serde_json::json!({ "value": c }));
        serde_json::json!({
            "discount": { "metafield": metafield },
            "cart": { "lines": lines }
        })
        .to_string()
    }

    #[test]
    fn test_empty_cart() -> Result<()> {
        let input = make_input(
            Some(r#"{"buy_quantity":2,"get_quantity":1,"get_percentage":100}"#),
            vec![],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_not_enough_items() -> Result<()> {
        // Need 2+1=3, only have 2
        let input = make_input(
            Some(r#"{"buy_quantity":2,"get_quantity":1,"get_percentage":100}"#),
            vec![make_line(
                "1",
                2,
                "25.00",
                false,
                "Onesie",
                default_tag_checks(),
            )],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_exact_bxgy_match() -> Result<()> {
        // Buy 2 get 1 free, 3 items → 1 discounted
        let input = make_input(
            Some(r#"{"buy_quantity":2,"get_quantity":1,"get_percentage":100}"#),
            vec![make_line(
                "1",
                3,
                "25.00",
                false,
                "Onesie",
                default_tag_checks(),
            )],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            let targets = &op.candidates[0].targets;
            assert_eq!(targets.len(), 1);
            // Should discount 1 item
            if let schema::ProductDiscountCandidateTarget::CartLine(t) = &targets[0] {
                assert_eq!(t.quantity, Some(1));
            }
        }
        Ok(())
    }

    #[test]
    fn test_multiple_sets() -> Result<()> {
        // Buy 2 get 1 free, 6 items → 2 sets → 2 discounted
        let input = make_input(
            Some(r#"{"buy_quantity":2,"get_quantity":1,"get_percentage":100}"#),
            vec![make_line(
                "1",
                6,
                "20.00",
                false,
                "Onesie",
                default_tag_checks(),
            )],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            if let schema::ProductDiscountCandidateTarget::CartLine(t) =
                &op.candidates[0].targets[0]
            {
                assert_eq!(t.quantity, Some(2));
            }
        }
        Ok(())
    }

    #[test]
    fn test_qualifying_tags_filter() -> Result<()> {
        // Only "bxgy" tagged items qualify; 3 tagged + 2 untagged
        let input = make_input(
            Some(
                r#"{"buy_quantity":2,"get_quantity":1,"get_percentage":100,"qualifying_tags":["bxgy"]}"#,
            ),
            vec![
                make_line("1", 3, "25.00", false, "Onesie", make_tag_checks(&["bxgy"])),
                make_line("2", 2, "30.00", false, "Shirt", default_tag_checks()),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            // Only line "1" should be in targets (3 items, 1 set, 1 discounted)
            assert_eq!(op.candidates[0].targets.len(), 1);
            if let schema::ProductDiscountCandidateTarget::CartLine(t) =
                &op.candidates[0].targets[0]
            {
                assert_eq!(t.id, "1");
            }
        }
        Ok(())
    }

    #[test]
    fn test_cheapest_discounted() -> Result<()> {
        // Buy 1 get 1 free, discount_cheapest=true (default)
        // Line 1: $10, Line 2: $30 → line 1 should be discounted
        let input = make_input(
            Some(
                r#"{"buy_quantity":1,"get_quantity":1,"get_percentage":100,"discount_cheapest":true}"#,
            ),
            vec![
                make_line("1", 1, "10.00", false, "Onesie", default_tag_checks()),
                make_line("2", 1, "30.00", false, "Shirt", default_tag_checks()),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            if let schema::ProductDiscountCandidateTarget::CartLine(t) =
                &op.candidates[0].targets[0]
            {
                assert_eq!(t.id, "1"); // cheapest
            }
        }
        Ok(())
    }

    #[test]
    fn test_most_expensive_discounted() -> Result<()> {
        // Buy 1 get 1, discount_cheapest=false → most expensive discounted
        let input = make_input(
            Some(
                r#"{"buy_quantity":1,"get_quantity":1,"get_percentage":50,"discount_cheapest":false}"#,
            ),
            vec![
                make_line("1", 1, "10.00", false, "Onesie", default_tag_checks()),
                make_line("2", 1, "30.00", false, "Shirt", default_tag_checks()),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            if let schema::ProductDiscountCandidateTarget::CartLine(t) =
                &op.candidates[0].targets[0]
            {
                assert_eq!(t.id, "2"); // most expensive
            }
        }
        Ok(())
    }

    #[test]
    fn test_gift_card_excluded() -> Result<()> {
        // 3 items but 1 is a gift card → only 2 qualifying, need 3 → empty
        let input = make_input(
            Some(
                r#"{"buy_quantity":2,"get_quantity":1,"get_percentage":100,"exclude_gift_cards":true}"#,
            ),
            vec![
                make_line("1", 2, "25.00", false, "Onesie", default_tag_checks()),
                make_line("2", 1, "15.00", true, "Gift Card", default_tag_checks()),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_gift_card_heuristic() -> Result<()> {
        // isGiftCard=false but productType="Gift Card" → excluded
        let input = make_input(
            Some(
                r#"{"buy_quantity":1,"get_quantity":1,"get_percentage":100,"exclude_gift_cards":true}"#,
            ),
            vec![
                make_line("1", 1, "25.00", false, "Onesie", default_tag_checks()),
                make_line("2", 1, "15.00", false, "Gift Card", default_tag_checks()),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        // Only 1 qualifying item, need 2 → empty
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_missing_metafield_defaults() -> Result<()> {
        // Default: buy 2 get 1 free
        let input = make_input(
            None,
            vec![make_line(
                "1",
                3,
                "20.00",
                false,
                "Onesie",
                default_tag_checks(),
            )],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            if let schema::ProductDiscountCandidateValue::Percentage(pct) = &op.candidates[0].value
            {
                assert_eq!(pct.value.to_string(), "100.0"); // default is 100% (free)
            }
        }
        Ok(())
    }

    #[test]
    fn test_partial_percentage() -> Result<()> {
        // 50% off instead of free
        let input = make_input(
            Some(r#"{"buy_quantity":2,"get_quantity":1,"get_percentage":50}"#),
            vec![make_line(
                "1",
                3,
                "20.00",
                false,
                "Onesie",
                default_tag_checks(),
            )],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            if let schema::ProductDiscountCandidateValue::Percentage(pct) = &op.candidates[0].value
            {
                assert_eq!(pct.value.to_string(), "50.0");
            }
        }
        Ok(())
    }

    #[test]
    fn test_zero_percentage_returns_empty() -> Result<()> {
        let input = make_input(
            Some(r#"{"buy_quantity":2,"get_quantity":1,"get_percentage":0}"#),
            vec![make_line(
                "1",
                3,
                "20.00",
                false,
                "Onesie",
                default_tag_checks(),
            )],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_all_gift_cards_returns_empty() -> Result<()> {
        let input = make_input(
            Some(r#"{"buy_quantity":1,"get_quantity":1,"get_percentage":100}"#),
            vec![
                make_line("1", 1, "25.00", true, "Gift Card", default_tag_checks()),
                make_line("2", 1, "15.00", true, "giftcard", default_tag_checks()),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }
}
