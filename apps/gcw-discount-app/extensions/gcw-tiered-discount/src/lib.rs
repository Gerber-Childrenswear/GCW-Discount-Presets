use serde::Deserialize;
use shopify_function::prelude::*;
use shopify_function::Result;
use std::collections::HashSet;

/// Default tiers: spend $50 → 10%, spend $100 → 15%, spend $150 → 20%
const DEFAULT_MESSAGE: &str = "Tiered discount applied!";

#[typegen("./schema.graphql")]
pub mod schema {
    #[query("./input.graphql")]
    pub mod run {}
}

use schema::run::input::cart::lines::Merchandise;

// ---------------------------------------------------------------------------
// Config — deserialized from the discount node's metafield JSON
// ---------------------------------------------------------------------------

/// A single tier: when the cart meets `min_value`, apply `percentage` off.
/// Tiers should be sorted ascending by `min_value` in the config; the function
/// picks the HIGHEST qualifying tier.
#[derive(Debug, Deserialize, Clone)]
struct Tier {
    /// Minimum cart subtotal (dollars) or minimum total quantity to qualify.
    min_value: f64,
    /// Percentage off for this tier (0–100).
    percentage: f64,
    /// Optional per-tier message override.
    message: Option<String>,
}

#[derive(Debug, Deserialize, Default, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
enum TierMode {
    /// Tiers are based on cart subtotal (dollar amount).
    #[default]
    Subtotal,
    /// Tiers are based on total item quantity in the cart.
    Quantity,
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct TieredConfig {
    /// Whether tiers are evaluated on subtotal or quantity.
    mode: TierMode,
    /// Ordered list of tiers (lowest min_value first).
    tiers: Vec<Tier>,
    /// Fallback message when the selected tier has no message.
    message: Option<String>,
    /// Whether to exclude gift cards from the discount targets.
    exclude_gift_cards: bool,
    /// Only discount products that carry at least one of these tags (allowlist).
    included_tags: Vec<String>,
}

impl Default for TieredConfig {
    fn default() -> Self {
        Self {
            mode: TierMode::Subtotal,
            tiers: vec![
                Tier {
                    min_value: 50.0,
                    percentage: 10.0,
                    message: None,
                },
                Tier {
                    min_value: 100.0,
                    percentage: 15.0,
                    message: None,
                },
                Tier {
                    min_value: 150.0,
                    percentage: 20.0,
                    message: None,
                },
            ],
            message: Some(DEFAULT_MESSAGE.to_string()),
            exclude_gift_cards: true,
            included_tags: Vec::new(),
        }
    }
}

fn read_config(input: &schema::run::Input) -> TieredConfig {
    input
        .discount()
        .metafield()
        .and_then(|mf| serde_json::from_str::<TieredConfig>(mf.value()).ok())
        .unwrap_or_default()
}

fn clamp_percentage(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

fn empty_result() -> schema::CartLinesDiscountsGenerateRunResult {
    schema::CartLinesDiscountsGenerateRunResult { operations: vec![] }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[shopify_function]
fn run(input: schema::run::Input) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    let mut config = read_config(&input);

    if config.tiers.is_empty() {
        return Ok(empty_result());
    }

    // Ensure tiers are sorted ascending by min_value for correct selection
    config.tiers.sort_by(|a, b| {
        a.min_value
            .partial_cmp(&b.min_value)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Compute the metric used to select the tier
    let metric: f64 = match config.mode {
        TierMode::Subtotal => input
            .cart()
            .cost()
            .subtotal_amount()
            .amount()
            .to_string()
            .parse::<f64>()
            .unwrap_or(0.0),
        TierMode::Quantity => input
            .cart()
            .lines()
            .iter()
            .map(|line| *line.quantity() as f64)
            .sum(),
    };

    // Find the highest qualifying tier (tiers should be ordered ascending)
    let total_tiers = config.tiers.len();
    let qualifying = config
        .tiers
        .iter()
        .enumerate()
        .rev()
        .find(|(_, t)| metric >= t.min_value);

    let (tier_index, tier) = match qualifying {
        Some((i, t)) => (i, t),
        None => return Ok(empty_result()), // Cart doesn't meet the lowest tier
    };
    let tier_number = tier_index + 1; // 1-based for display

    let percentage_value = clamp_percentage(tier.percentage);
    if percentage_value <= 0.0 {
        return Ok(empty_result());
    }

    // Build the tag allowlist (normalized to lowercase)
    let included_tags: HashSet<String> = config
        .included_tags
        .iter()
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect();

    // Build discount targets — all eligible cart lines
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

            // Exclude gift cards if configured
            if config.exclude_gift_cards && *product.is_gift_card() {
                return None;
            }
            if config.exclude_gift_cards {
                if let Some(pt) = product.product_type() {
                    let lower = pt.to_ascii_lowercase();
                    if lower.contains("gift card") || lower.contains("giftcard") {
                        return None;
                    }
                }
            }

            // Tag allowlist: if included_tags is set, product must match at least one
            if !included_tags.is_empty() {
                let product_tags: HashSet<String> = product
                    .tag_checks()
                    .iter()
                    .filter(|tc| *tc.has_tag())
                    .map(|tc| tc.tag().to_ascii_lowercase())
                    .collect();
                if !product_tags.iter().any(|t| included_tags.contains(t)) {
                    return None;
                }
            }

            Some(schema::ProductDiscountCandidateTarget::CartLine(
                schema::CartLineTarget {
                    id: line.id().to_string(),
                    quantity: None,
                },
            ))
        })
        .collect();

    if targets.is_empty() {
        return Ok(empty_result());
    }

    // Build the discount message.
    // Priority: per-tier override → config-level fallback → smart default.
    // The smart default shows the earned tier and percentage, plus a nudge
    // toward the next tier when one exists.
    // Ignore legacy boilerplate messages so the smart default takes over.
    let is_useful_message = |m: &Option<String>| -> bool {
        match m {
            Some(s) => {
                let trimmed = s.trim();
                !trimmed.is_empty() && trimmed != "Tiered discount applied!"
            }
            None => false,
        }
    };
    let message = if is_useful_message(&tier.message) {
        tier.message.clone().unwrap()
    } else if is_useful_message(&config.message) {
        config.message.clone().unwrap()
    } else {
        let pct = percentage_value as u32;
        let base = format!("Tier {} unlocked: {}% off!", tier_number, pct);

        // If there is a higher tier, append a short upsell nudge
        if tier_number < total_tiers {
            let next = &config.tiers[tier_index + 1];
            let next_pct = next.percentage as u32;
            match config.mode {
                TierMode::Subtotal => {
                    let gap = next.min_value - metric;
                    if gap > 0.0 {
                        format!(
                            "{} Add ${:.0} more for {}% off!",
                            base,
                            gap.ceil(),
                            next_pct
                        )
                    } else {
                        base
                    }
                }
                TierMode::Quantity => {
                    let gap = next.min_value - metric;
                    if gap > 0.0 {
                        format!(
                            "{} Add {} more for {}% off!",
                            base,
                            gap.ceil() as u32,
                            next_pct
                        )
                    } else {
                        base
                    }
                }
            }
        } else {
            // Already at the highest tier
            format!("Best deal! Tier {}: {}% off!", tier_number, pct)
        }
    };

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

// ===========================================================================
// Tests
// ===========================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use shopify_function::{run_function_with_input, Result};

    fn make_line(id: &str, qty: i32, product_type: &str, is_gift_card: bool) -> serde_json::Value {
        make_line_with_tags(id, qty, product_type, is_gift_card, &[])
    }

    fn make_line_with_tags(
        id: &str,
        qty: i32,
        product_type: &str,
        is_gift_card: bool,
        tags: &[(&str, bool)],
    ) -> serde_json::Value {
        let tag_checks: Vec<serde_json::Value> = if tags.is_empty() {
            // Default: all known tags set to false
            [
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
            ]
            .iter()
            .map(|t| serde_json::json!({ "hasTag": false, "tag": t }))
            .collect()
        } else {
            tags.iter()
                .map(|(t, has)| serde_json::json!({ "hasTag": has, "tag": t }))
                .collect()
        };
        serde_json::json!({
            "id": id,
            "quantity": qty,
            "cost": {
                "amountPerQuantity": { "amount": "25.00" }
            },
            "merchandise": {
                "__typename": "ProductVariant",
                "id": format!("gid://shopify/ProductVariant/{}", id),
                "product": {
                    "id": format!("gid://shopify/Product/{}", id),
                    "productType": product_type,
                    "isGiftCard": is_gift_card,
                    "vendor": "Gerber",
                    "tagChecks": tag_checks
                }
            }
        })
    }

    fn make_input(
        config_json: Option<&str>,
        subtotal: &str,
        lines: Vec<serde_json::Value>,
    ) -> String {
        let metafield = config_json.map(|c| serde_json::json!({ "value": c }));
        serde_json::json!({
            "discount": { "metafield": metafield },
            "cart": {
                "cost": {
                    "subtotalAmount": { "amount": subtotal, "currencyCode": "USD" }
                },
                "lines": lines
            }
        })
        .to_string()
    }

    #[test]
    fn test_empty_cart() -> Result<()> {
        let input = make_input(
            Some(r#"{"tiers":[{"min_value":50,"percentage":10}]}"#),
            "100.00",
            vec![],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_empty_tiers() -> Result<()> {
        let input = make_input(
            Some(r#"{"tiers":[]}"#),
            "100.00",
            vec![make_line("1", 2, "Onesie", false)],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_below_lowest_tier() -> Result<()> {
        let input = make_input(
            Some(
                r#"{"tiers":[{"min_value":50,"percentage":10},{"min_value":100,"percentage":20}]}"#,
            ),
            "30.00",
            vec![make_line("1", 1, "Onesie", false)],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_exact_tier_boundary() -> Result<()> {
        let input = make_input(
            Some(
                r#"{"tiers":[{"min_value":50,"percentage":10},{"min_value":100,"percentage":20}]}"#,
            ),
            "50.00",
            vec![make_line("1", 2, "Onesie", false)],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        Ok(())
    }

    #[test]
    fn test_highest_tier_applied() -> Result<()> {
        let input = make_input(
            Some(
                r#"{"tiers":[{"min_value":50,"percentage":10},{"min_value":100,"percentage":20}]}"#,
            ),
            "200.00",
            vec![make_line("1", 5, "Onesie", false)],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        // 20% should be applied for the highest tier
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            if let schema::ProductDiscountCandidateValue::Percentage(pct) = &op.candidates[0].value
            {
                assert_eq!(pct.value.to_string(), "20.0");
            } else {
                panic!("Expected Percentage value");
            }
        } else {
            panic!("Expected ProductDiscountsAdd");
        }
        Ok(())
    }

    #[test]
    fn test_quantity_mode() -> Result<()> {
        // 3 items total → qualifies for min_value:3 tier (15%)
        let input = make_input(
            Some(
                r#"{"mode":"quantity","tiers":[{"min_value":2,"percentage":10},{"min_value":5,"percentage":20}]}"#,
            ),
            "10.00",
            vec![make_line("1", 3, "Onesie", false)],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            if let schema::ProductDiscountCandidateValue::Percentage(pct) = &op.candidates[0].value
            {
                assert_eq!(pct.value.to_string(), "10.0");
            }
        }
        Ok(())
    }

    #[test]
    fn test_quantity_mode_multiple_lines() -> Result<()> {
        // 2+4 = 6 items → qualifies for min_value:5 tier (20%)
        let input = make_input(
            Some(
                r#"{"mode":"quantity","tiers":[{"min_value":2,"percentage":10},{"min_value":5,"percentage":20}]}"#,
            ),
            "10.00",
            vec![
                make_line("1", 2, "Onesie", false),
                make_line("2", 4, "Shirt", false),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            if let schema::ProductDiscountCandidateValue::Percentage(pct) = &op.candidates[0].value
            {
                assert_eq!(pct.value.to_string(), "20.0");
            }
            assert_eq!(op.candidates[0].targets.len(), 2);
        }
        Ok(())
    }

    #[test]
    fn test_gift_card_excluded_by_flag() -> Result<()> {
        let input = make_input(
            Some(r#"{"tiers":[{"min_value":10,"percentage":15}],"exclude_gift_cards":true}"#),
            "60.00",
            vec![make_line("1", 1, "Gift Card", true)],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_gift_card_heuristic_product_type() -> Result<()> {
        let input = make_input(
            Some(r#"{"tiers":[{"min_value":10,"percentage":15}],"exclude_gift_cards":true}"#),
            "60.00",
            vec![make_line("1", 1, "Gift Card", false)],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_missing_metafield_uses_defaults() -> Result<()> {
        // Default: $50/10%, $100/15%, $150/20%
        let input = make_input(None, "120.00", vec![make_line("1", 3, "Onesie", false)]);
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        // $120 qualifies for $100/15% tier
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            if let schema::ProductDiscountCandidateValue::Percentage(pct) = &op.candidates[0].value
            {
                assert_eq!(pct.value.to_string(), "15.0");
            }
        }
        Ok(())
    }

    #[test]
    fn test_zero_percentage_tier() -> Result<()> {
        let input = make_input(
            Some(r#"{"tiers":[{"min_value":10,"percentage":0}]}"#),
            "100.00",
            vec![make_line("1", 2, "Onesie", false)],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_percentage_clamped_to_100() -> Result<()> {
        let input = make_input(
            Some(r#"{"tiers":[{"min_value":10,"percentage":200}]}"#),
            "100.00",
            vec![make_line("1", 2, "Onesie", false)],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            if let schema::ProductDiscountCandidateValue::Percentage(pct) = &op.candidates[0].value
            {
                assert_eq!(pct.value.to_string(), "100.0");
            }
        }
        Ok(())
    }

    #[test]
    fn test_custom_tier_message() -> Result<()> {
        let input = make_input(
            Some(r#"{"tiers":[{"min_value":10,"percentage":15,"message":"Big savings!"}]}"#),
            "100.00",
            vec![make_line("1", 2, "Onesie", false)],
        );
        let result = run_function_with_input(run, &input)?;
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            assert_eq!(op.candidates[0].message.as_deref(), Some("Big savings!"));
        }
        Ok(())
    }

    #[test]
    fn test_all_gift_cards_returns_empty() -> Result<()> {
        let input = make_input(
            Some(r#"{"tiers":[{"min_value":10,"percentage":15}]}"#),
            "100.00",
            vec![
                make_line("1", 1, "Gift Card", true),
                make_line("2", 1, "giftcard", false),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_tag_filter_includes_matching() -> Result<()> {
        let input = make_input(
            Some(r#"{"tiers":[{"min_value":10,"percentage":15}],"included_tags":["sale"]}"#),
            "100.00",
            vec![
                make_line_with_tags(
                    "1",
                    2,
                    "Onesie",
                    false,
                    &[("sale", true), ("discount", false)],
                ),
                make_line_with_tags(
                    "2",
                    1,
                    "Pants",
                    false,
                    &[("sale", false), ("discount", false)],
                ),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        // Only line "1" should be targeted (has "sale" tag)
        if let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] {
            assert_eq!(op.candidates[0].targets.len(), 1);
        }
        Ok(())
    }

    #[test]
    fn test_tag_filter_excludes_all_returns_empty() -> Result<()> {
        let input = make_input(
            Some(r#"{"tiers":[{"min_value":10,"percentage":15}],"included_tags":["clearance"]}"#),
            "100.00",
            vec![make_line_with_tags(
                "1",
                2,
                "Onesie",
                false,
                &[("sale", false), ("clearance", false)],
            )],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_empty_tags_applies_to_all() -> Result<()> {
        // Empty included_tags means no filter — all products qualify
        let input = make_input(
            Some(r#"{"tiers":[{"min_value":10,"percentage":15}],"included_tags":[]}"#),
            "100.00",
            vec![make_line("1", 2, "Onesie", false)],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        Ok(())
    }
}
