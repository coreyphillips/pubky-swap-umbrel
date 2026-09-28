//! Load an Umbrel identity without opening a transport or creating swap state.

use anyhow::Result;
use std::path::PathBuf;

fn main() -> Result<()> {
    let path = PathBuf::from(std::env::var("PUBKY_SWAP_CONFIG")?);
    let config: swap_client::ClientConfig =
        swap_config::load(Some(&path), "PUBKY_SWAP_", &serde_json::json!({}))?;
    let identity = config.identity()?;
    let secret = pubky_transport::identity::secret_from_recovery(
        identity.method,
        &identity.value,
        &identity.passphrase,
    )?;
    println!(
        "IDENTITY pubky={}",
        pubky_transport::identity::pubky_from_secret(&secret)
    );
    Ok(())
}
