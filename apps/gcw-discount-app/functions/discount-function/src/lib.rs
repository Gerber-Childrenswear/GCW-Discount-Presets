use shopify_function::prelude::*;
use shopify_function::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiscountConfig {
    pub discount_id: String,
    pub percentage: f64,
    pub message: String,
    pub included_tags: Vec<String>,
    pub excluded_tags: Vec<String>,
}

impl DiscountConfig {
    fn from_json(json_str: &str) -> Option<Self> {
        serde_json::from_str(json_str).ok()
    }
}

#[typegen("./schema.graphql")]
pub mod schema {
    #[query("./input.graphql")]
    pub mod run {}
}

#[shopify_function]
fn run(input: schema::run::Input) -> Result<schema::FunctionRunResult> {
    let no_discount = schema::FunctionRunResult {
        discounts: vec![],
        discount_application_strategy: schema::DiscountApplicationStrategy::First,
    };

    let cart = input.cart();

    // Check for disallowed discount codes
    let mut has_disallowed_code = false;
    for code in cart.discount_codes() {
        if !is_allowed_discount_code(code.code()) {
            has_disallowed_code = true;
            break;
        }
    }

    if has_disallowed_code {
        return Ok(no_discount);
    }

    // Try to get discount configuration from metafield
    let config = match input.shop() {
        Some(shop) => {
            let metafields = shop.metafields();
            metafields
                .nodes()
                .iter()
                .find_map(|mf| {
                    if mf.key() == "active_discount_config" {
                        DiscountConfig::from_json(mf.value())
                    } else {
                        None
                    }
                })
        }
        None => None,
    };

    // Return no discount if no config found
    let config = match config {
        Some(cfg) => cfg,
        None => {
            return Ok(no_discount);
        }
    };

    // Filter products based on included tags
    let targets = cart
        .lines()
        .iter()
        .filter_map(|line| {
            let variant = line.merchandise();
            let product = variant.product();

            // Check if product has at least one included tag
            let product_tags: Vec<String> = product.tags().iter().map(|s| s.to_lowercase()).collect();
            let has_included_tag = config
                .included_tags
                .iter()
                .any(|tag| product_tags.contains(&tag.to_lowercase()));

            // Check if product is excluded
            let is_excluded = config
                .excluded_tags
                .iter()
                .any(|tag| product_tags.contains(&tag.to_lowercase()))
                || is_excluded_product(product.product_type());

            if has_included_tag && !is_excluded {
                Some(schema::Target {
                    product_variant: Some(schema::ProductVariantTarget {
                        id: variant.id().to_string(),
                        quantity: None,
                    }),
                })
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    if targets.is_empty() {
        return Ok(no_discount);
    }

    let percentage = schema::Percentage {
        value: Decimal::from(config.percentage),
    };

    Ok(schema::FunctionRunResult {
        discounts: vec![schema::Discount {
            message: Some(config.message.clone()),
            targets,
            value: schema::Value {
                percentage: Some(percentage),
            },
        }],
        discount_application_strategy: schema::DiscountApplicationStrategy::First,
    })
}

fn is_allowed_discount_code(code: &str) -> bool {
    let normalized = code.to_ascii_lowercase();
    normalized.contains("sms")
        || normalized.contains("freeshipping")
        || normalized.contains("perks")
}

fn is_excluded_product(product_type: Option<&String>) -> bool {
    if let Some(pt) = product_type {
        let normalized_type = pt.to_ascii_lowercase();
        if normalized_type.contains("gift card") || normalized_type.contains("giftcard") {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_perks_sms_and_freeshipping_codes() {
        assert!(is_allowed_discount_code("SMS2026"));
        assert!(is_allowed_discount_code("freeshipping"));
        assert!(is_allowed_discount_code("PerksMember"));
    }

    #[test]
    fn config_parses_from_json() {
        let json = r#"{"discount_id":"perc-003","percentage":25.0,"message":"25% Off!","included_tags":["discount"],"excluded_tags":["no-discount"]}"#;
        let config = DiscountConfig::from_json(json);
        assert!(config.is_some());
    }

    #[test]
    fn excludes_gift_cards() {
        assert!(is_excluded_product(Some(&"Gift Card".to_string())));
        assert!(!is_excluded_product(Some(&"T-Shirt".to_string())));
    }
}
