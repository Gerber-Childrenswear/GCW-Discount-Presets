use serde::Deserialize;
use shopify_function::prelude::*;
use shopify_function::Result;

const DEFAULT_THRESHOLD: f64 = 50.0;
const DEFAULT_MESSAGE: &str = "Free Shipping";

#[typegen("./schema.graphql")]
pub mod schema {
    #[query("./input.graphql")]
    pub mod run {}
}

/// Config read from the discount node metafield (namespace: "gcw", key: "shipping_config").
/// Example JSON: {"threshold": 50, "message": "Free shipping on orders $50+!"}
#[derive(Debug, Deserialize)]
#[serde(default)]
struct ShippingConfig {
    /// Minimum cart subtotal (in dollars) to qualify for free shipping.
    /// Clamped to 10–100.
    threshold: f64,
    /// Message shown to the customer at checkout.
    message: Option<String>,
}

impl Default for ShippingConfig {
    fn default() -> Self {
        Self {
            threshold: DEFAULT_THRESHOLD,
            message: Some(DEFAULT_MESSAGE.to_string()),
        }
    }
}

fn read_config(input: &schema::run::Input) -> ShippingConfig {
    input
        .discount()
        .metafield()
        .and_then(|mf| serde_json::from_str::<ShippingConfig>(mf.value()).ok())
        .unwrap_or_default()
}

fn clamp_threshold(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(10.0, 100.0)
    } else {
        DEFAULT_THRESHOLD
    }
}

fn empty_result() -> schema::CartDeliveryOptionsDiscountsGenerateRunResult {
    schema::CartDeliveryOptionsDiscountsGenerateRunResult { operations: vec![] }
}

#[shopify_function]
fn run(input: schema::run::Input) -> Result<schema::CartDeliveryOptionsDiscountsGenerateRunResult> {
    let config = read_config(&input);
    let threshold = clamp_threshold(config.threshold);

    // Parse cart subtotal — Decimal doesn't impl parse(), so convert to &str first
    let subtotal: f64 = input
        .cart()
        .cost()
        .subtotal_amount()
        .amount()
        .to_string()
        .parse::<f64>()
        .unwrap_or(0.0);

    // Legacy Script Editor parity: qualify only when subtotal is strictly greater than threshold.
    if subtotal <= threshold {
        return Ok(empty_result());
    }

    let message = config
        .message
        .unwrap_or_else(|| DEFAULT_MESSAGE.to_string());

    // Build targets: apply 100% off to every delivery group
    let targets: Vec<schema::DeliveryDiscountCandidateTarget> = input
        .cart()
        .delivery_groups()
        .iter()
        .map(|group| {
            schema::DeliveryDiscountCandidateTarget::DeliveryGroup(schema::DeliveryGroupTarget {
                id: group.id().to_string(),
            })
        })
        .collect();

    if targets.is_empty() {
        return Ok(empty_result());
    }

    let candidate = schema::DeliveryDiscountCandidate {
        associated_discount_code: None,
        message: Some(message),
        targets,
        value: schema::DeliveryDiscountCandidateValue::Percentage(schema::Percentage {
            value: Decimal::from(100.0_f64),
        }),
    };

    Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult {
        operations: vec![schema::DeliveryOperation::DeliveryDiscountsAdd(
            schema::DeliveryDiscountsAddOperation {
                candidates: vec![candidate],
                selection_strategy: schema::DeliveryDiscountSelectionStrategy::All,
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

    fn make_delivery_group(id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "deliveryOptions": [{
                "handle": "standard",
                "title": "Standard Shipping",
                "cost": { "amount": "5.99" }
            }]
        })
    }

    fn make_input(
        config_json: Option<&str>,
        subtotal: &str,
        groups: Vec<serde_json::Value>,
    ) -> String {
        let metafield = config_json.map(|c| serde_json::json!({ "value": c }));
        serde_json::json!({
            "discount": { "metafield": metafield },
            "cart": {
                "cost": {
                    "subtotalAmount": { "amount": subtotal, "currencyCode": "USD" }
                },
                "deliveryGroups": groups
            }
        })
        .to_string()
    }

    #[test]
    fn test_empty_delivery_groups() -> Result<()> {
        let input = make_input(Some(r#"{"threshold":50}"#), "100.00", vec![]);
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_below_threshold() -> Result<()> {
        let input = make_input(
            Some(r#"{"threshold":50}"#),
            "30.00",
            vec![make_delivery_group("gid://shopify/CartDeliveryGroup/1")],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_at_threshold() -> Result<()> {
        let input = make_input(
            Some(r#"{"threshold":50}"#),
            "50.00",
            vec![make_delivery_group("gid://shopify/CartDeliveryGroup/1")],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_above_threshold() -> Result<()> {
        let input = make_input(
            Some(r#"{"threshold":50}"#),
            "120.00",
            vec![make_delivery_group("gid://shopify/CartDeliveryGroup/1")],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::DeliveryOperation::DeliveryDiscountsAdd(op) = &result.operations[0] {
            assert_eq!(op.candidates[0].targets.len(), 1);
            if let schema::DeliveryDiscountCandidateValue::Percentage(pct) = &op.candidates[0].value
            {
                assert_eq!(pct.value.to_string(), "100.0"); // 100% off = free shipping
            }
        }
        Ok(())
    }

    #[test]
    fn test_missing_metafield_defaults() -> Result<()> {
        // Default: $50 threshold
        let input = make_input(
            None,
            "60.00",
            vec![make_delivery_group("gid://shopify/CartDeliveryGroup/1")],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        Ok(())
    }

    #[test]
    fn test_missing_metafield_below_default() -> Result<()> {
        // Default: $50 threshold, subtotal is $30
        let input = make_input(
            None,
            "30.00",
            vec![make_delivery_group("gid://shopify/CartDeliveryGroup/1")],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty());
        Ok(())
    }

    #[test]
    fn test_custom_message() -> Result<()> {
        let input = make_input(
            Some(r#"{"threshold":25,"message":"Yay free shipping!"}"#),
            "50.00",
            vec![make_delivery_group("gid://shopify/CartDeliveryGroup/1")],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::DeliveryOperation::DeliveryDiscountsAdd(op) = &result.operations[0] {
            assert_eq!(
                op.candidates[0].message.as_deref(),
                Some("Yay free shipping!")
            );
        }
        Ok(())
    }

    #[test]
    fn test_threshold_clamped_low() -> Result<()> {
        // Threshold 5 → clamped to 10; subtotal $9 → below
        let input = make_input(
            Some(r#"{"threshold":5}"#),
            "9.00",
            vec![make_delivery_group("gid://shopify/CartDeliveryGroup/1")],
        );
        let result = run_function_with_input(run, &input)?;
        assert!(result.operations.is_empty()); // 9 < clamped 10
        Ok(())
    }

    #[test]
    fn test_threshold_clamped_high() -> Result<()> {
        // Threshold 500 → clamped to 100; subtotal $100.01 → above threshold
        let input = make_input(
            Some(r#"{"threshold":500}"#),
            "100.01",
            vec![make_delivery_group("gid://shopify/CartDeliveryGroup/1")],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        Ok(())
    }

    #[test]
    fn test_multiple_delivery_groups() -> Result<()> {
        let input = make_input(
            Some(r#"{"threshold":50}"#),
            "75.00",
            vec![
                make_delivery_group("gid://shopify/CartDeliveryGroup/1"),
                make_delivery_group("gid://shopify/CartDeliveryGroup/2"),
            ],
        );
        let result = run_function_with_input(run, &input)?;
        assert_eq!(result.operations.len(), 1);
        if let schema::DeliveryOperation::DeliveryDiscountsAdd(op) = &result.operations[0] {
            assert_eq!(op.candidates[0].targets.len(), 2);
        }
        Ok(())
    }
}
