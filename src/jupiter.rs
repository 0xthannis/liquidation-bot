//! Jupiter V6 API - Client HTTP direct
//! Pas besoin de SDK, on utilise l'API REST directement

use anyhow::{Result, anyhow};
use solana_sdk::pubkey::Pubkey;
use serde::{Deserialize, Serialize};
use reqwest::Client;

const JUPITER_API_URL: &str = "https://quote-api.jup.ag/v6";

/// Client Jupiter HTTP
pub struct JupiterClient {
    client: Client,
    base_url: String,
}

impl JupiterClient {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            base_url: JUPITER_API_URL.to_string(),
        }
    }

    /// Obtenir une quote pour un swap
    pub async fn get_quote(
        &self,
        input_mint: &Pubkey,
        output_mint: &Pubkey,
        amount: u64,
        slippage_bps: u16,
    ) -> Result<QuoteResponse> {
        let url = format!(
            "{}/quote?inputMint={}&outputMint={}&amount={}&slippageBps={}",
            self.base_url,
            input_mint,
            output_mint,
            amount,
            slippage_bps
        );

        let response = self.client
            .get(&url)
            .send()
            .await
            .map_err(|e| anyhow!("Erreur HTTP Jupiter: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!("Jupiter API error {}: {}", status, body));
        }

        response.json::<QuoteResponse>()
            .await
            .map_err(|e| anyhow!("Erreur parsing quote: {}", e))
    }

    /// Obtenir la transaction de swap
    pub async fn get_swap_transaction(
        &self,
        quote: &QuoteResponse,
        user_public_key: &Pubkey,
    ) -> Result<SwapResponse> {
        let url = format!("{}/swap", self.base_url);

        let request = SwapRequest {
            quote_response: quote.clone(),
            user_public_key: user_public_key.to_string(),
            wrap_and_unwrap_sol: true,
            dynamic_compute_unit_limit: true,
            priority_level_with_max_lamports: PriorityLevel {
                priority_level: "low".to_string(),
                max_lamports: 5000, // Minimum fees (~0.000005 SOL)
            },
        };

        let response = self.client
            .post(&url)
            .json(&request)
            .send()
            .await
            .map_err(|e| anyhow!("Erreur HTTP swap: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!("Jupiter swap error {}: {}", status, body));
        }

        response.json::<SwapResponse>()
            .await
            .map_err(|e| anyhow!("Erreur parsing swap: {}", e))
    }
}

/// Réponse de quote Jupiter
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteResponse {
    pub input_mint: String,
    pub in_amount: String,
    pub output_mint: String,
    pub out_amount: String,
    pub other_amount_threshold: String,
    pub swap_mode: String,
    pub slippage_bps: u16,
    pub price_impact_pct: String,
    pub route_plan: Vec<RoutePlan>,
    #[serde(default)]
    pub context_slot: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePlan {
    pub swap_info: SwapInfo,
    pub percent: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapInfo {
    pub amm_key: String,
    pub label: Option<String>,
    pub input_mint: String,
    pub output_mint: String,
    pub in_amount: String,
    pub out_amount: String,
    pub fee_amount: String,
    pub fee_mint: String,
}

/// Request pour obtenir la transaction de swap
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapRequest {
    pub quote_response: QuoteResponse,
    pub user_public_key: String,
    pub wrap_and_unwrap_sol: bool,
    pub dynamic_compute_unit_limit: bool,
    pub priority_level_with_max_lamports: PriorityLevel,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriorityLevel {
    pub priority_level: String,
    pub max_lamports: u64,
}

/// Réponse de swap Jupiter (transaction base64)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct SwapResponse {
    pub swap_transaction: String,
    #[serde(default)]
    pub last_valid_block_height: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_jupiter_quote() {
        let client = JupiterClient::new();
        let sol_mint = Pubkey::from_str("So11111111111111111111111111111111111111112").unwrap();
        let usdc_mint = Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap();
        
        let result = client.get_quote(&sol_mint, &usdc_mint, 1000000000, 50).await;
        assert!(result.is_ok());
    }
}
