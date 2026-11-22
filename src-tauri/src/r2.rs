//! Uploads slides to Cloudflare R2 (S3-compatible API, signature v4) so Buffer can fetch
//! them from a public URL. Buffer has no upload endpoint of its own.

use crate::settings::{self, Settings};
use anyhow::{bail, Context, Result};
use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

pub struct R2 {
    account_id: String,
    access_key_id: String,
    secret: String,
    bucket: String,
    public_url: String,
}

impl R2 {
    pub fn from_settings(s: &Settings) -> Result<Self> {
        let missing: Vec<&str> = [
            ("account ID", &s.r2_account_id),
            ("access key ID", &s.r2_access_key_id),
            ("bucket", &s.r2_bucket),
            ("public URL", &s.r2_public_url),
        ]
        .iter()
        .filter(|(_, v)| v.trim().is_empty())
        .map(|(k, _)| *k)
        .collect();
        if !missing.is_empty() {
            bail!("Fill in the R2 {} in Settings first", missing.join(", "));
        }
        Ok(Self {
            account_id: s.r2_account_id.clone(),
            access_key_id: s.r2_access_key_id.clone(),
            secret: settings::r2_secret()?,
            bucket: s.r2_bucket.clone(),
            public_url: s.r2_public_url.trim_end_matches('/').to_string(),
        })
    }

    /// Uploads bytes and returns their public URL.
    pub fn upload_bytes(&self, key: &str, body: Vec<u8>, content_type: &str) -> Result<String> {
        self.put(key, body, content_type)?;
        Ok(format!("{}/{}", self.public_url, key))
    }

    fn put(&self, key: &str, body: Vec<u8>, content_type: &str) -> Result<()> {
        if !key.chars().all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c)) {
            bail!("Unsupported characters in object key {key}");
        }
        let host = format!("{}.r2.cloudflarestorage.com", self.account_id);
        let path = format!("/{}/{}", self.bucket, key);
        let now = Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date = now.format("%Y%m%d").to_string();
        let payload_hash = hex::encode(Sha256::digest(&body));

        let signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date";
        let canonical = format!(
            "PUT\n{path}\n\ncontent-type:{content_type}\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n\n{signed_headers}\n{payload_hash}"
        );
        let scope = format!("{date}/auto/s3/aws4_request");
        let to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", hex::encode(Sha256::digest(canonical.as_bytes())));
        let k = signing_key(&self.secret, &date, "auto", "s3");
        let signature = hex::encode(hmac(&k, to_sign.as_bytes()));
        let auth = format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.access_key_id
        );

        let resp = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()?
            .put(format!("https://{host}{path}"))
            .header("content-type", content_type)
            .header("x-amz-content-sha256", &payload_hash)
            .header("x-amz-date", &amz_date)
            .header("authorization", auth)
            .body(body)
            .send()
            .context("Couldn't reach Cloudflare R2")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().unwrap_or_default();
            let code = between(&text, "<Code>", "</Code>").unwrap_or("");
            let msg = between(&text, "<Message>", "</Message>").unwrap_or(&text);
            bail!("R2 upload failed ({status} {code}): {msg}");
        }
        Ok(())
    }

    /// Uploads a tiny file and fetches it back through the public URL, to check the whole setup.
    pub fn check(&self) -> Result<String> {
        let key = "openugc/connection-check.txt";
        self.put(key, b"ok".to_vec(), "text/plain")?;
        let url = format!("{}/{}", self.public_url, key);
        let resp = reqwest::blocking::get(&url).with_context(|| format!("Uploaded, but couldn't fetch {url}"))?;
        if !resp.status().is_success() {
            bail!(
                "Uploaded, but {url} returned {}. Check that public access is turned on for the bucket and the public URL is right.",
                resp.status()
            );
        }
        Ok(url)
    }
}

fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let mut k = hmac(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    for part in [region, service, "aws4_request"] {
        k = hmac(&k, part.as_bytes());
    }
    k
}

#[cfg(test)]
mod tests {
    /// Example from AWS's "Examples of how to derive a signing key for Signature Version 4".
    #[test]
    fn derives_aws_example_signing_key() {
        let k = super::signing_key("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam");
        assert_eq!(hex::encode(k), "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
    }
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key length");
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

fn between<'a>(s: &'a str, a: &str, b: &str) -> Option<&'a str> {
    let start = s.find(a)? + a.len();
    let end = s[start..].find(b)? + start;
    Some(&s[start..end])
}
