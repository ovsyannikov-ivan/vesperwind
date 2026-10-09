//! FTPS certificate verification: the operating system trust store through
//! rustls-platform-verifier, optionally replaced by an explicit pin of one
//! certificate for one endpoint. A rejected certificate is recorded with the
//! details a confirmation dialog needs; it is never trusted automatically.
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    CertificateError, ClientConfig, DigitallySignedStruct, SignatureScheme,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    net::IpAddr,
    sync::{Arc, Mutex},
};

/// What a rejected server certificate looked like, without any secret.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CertificateDetails {
    /// `host:port` the connection was made to.
    pub endpoint: String,
    /// SHA-256 of the DER certificate, 64 lowercase hex digits (the pin format).
    pub sha256: String,
    pub subject: String,
    pub issuer: String,
    pub not_before: Option<String>,
    pub not_after: Option<String>,
    pub dns_names: Vec<String>,
    pub ip_addresses: Vec<String>,
    /// `untrusted`, `expired`, `notYetValid`, `hostname`, `changed` or `invalid`.
    pub reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_sha256: Option<String>,
}

pub fn fingerprint(certificate: &[u8]) -> String {
    Sha256::digest(certificate)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub struct TlsPolicy {
    pub host: String,
    pub port: u16,
    /// Explicitly trusted certificate (settings `tlsTrustedCertificate`).
    pub pin: Option<String>,
    /// Additional trust anchors, for tests and the debug acceptance only.
    pub extra_roots: Vec<CertificateDer<'static>>,
}

/// The configuration shared by the control and every data connection of
/// one session, so TLS sessions can be resumed, plus the observed rejection.
pub struct TlsSetup {
    pub config: Arc<ClientConfig>,
    pub rejection: Arc<Mutex<Option<CertificateDetails>>>,
}

pub fn client_config(policy: &TlsPolicy) -> Result<TlsSetup, rustls::Error> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = policy.extra_roots.clone();
    roots.extend(debug_test_roots());
    let platform: Arc<dyn ServerCertVerifier> = Arc::new(if roots.is_empty() {
        rustls_platform_verifier::Verifier::new(provider.clone())?
    } else {
        rustls_platform_verifier::Verifier::new_with_extra_roots(roots, provider.clone())?
    });
    let rejection = Arc::new(Mutex::new(None));
    let verifier = EndpointVerifier {
        platform,
        pin: policy.pin.clone().filter(|pin| !pin.is_empty()),
        endpoint: format!("{}:{}", policy.host, policy.port),
        rejection: Arc::clone(&rejection),
    };
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    Ok(TlsSetup {
        config: Arc::new(config),
        rejection,
    })
}

/// Debug builds trust an additional CA named by `VESPERWIND_FTP_TEST_CA` (a
/// PEM file), so the native acceptance can use a synthetic CA without
/// touching the system trust store. Release builds never read it.
fn debug_test_roots() -> Vec<CertificateDer<'static>> {
    #[cfg(debug_assertions)]
    {
        use rustls::pki_types::pem::PemObject;
        if let Some(path) = std::env::var_os("VESPERWIND_FTP_TEST_CA") {
            return CertificateDer::pem_file_iter(path)
                .map(|items| items.filter_map(Result::ok).collect())
                .unwrap_or_default();
        }
    }
    Vec::new()
}

#[derive(Debug)]
struct EndpointVerifier {
    platform: Arc<dyn ServerCertVerifier>,
    pin: Option<String>,
    endpoint: String,
    rejection: Arc<Mutex<Option<CertificateDetails>>>,
}

impl EndpointVerifier {
    fn reject(&self, details: CertificateDetails, error: rustls::Error) -> rustls::Error {
        *self.rejection.lock().unwrap_or_else(|e| e.into_inner()) = Some(details);
        error
    }
}

impl ServerCertVerifier for EndpointVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let sha256 = fingerprint(end_entity);
        let details = |reason| {
            let mut details = describe(end_entity, &self.endpoint, reason);
            details.pinned_sha256 = self.pin.clone();
            details
        };
        if let Some(pin) = &self.pin {
            // An explicit pin replaces chain, name and validity checks for
            // exactly this certificate; any other certificate is refused.
            return if *pin == sha256 {
                Ok(ServerCertVerified::assertion())
            } else {
                Err(self.reject(
                    details("changed"),
                    rustls::Error::InvalidCertificate(
                        CertificateError::ApplicationVerificationFailure,
                    ),
                ))
            };
        }
        match self.platform.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        ) {
            Ok(verified) => Ok(verified),
            Err(error) => {
                let mut rejected = details("untrusted");
                rejected.reason = classify(&error, &rejected, server_name, now);
                Err(self.reject(rejected, error))
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.platform.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.platform.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.platform.supported_verify_schemes()
    }
}

/// A specific reason when rustls or the certificate itself says so; the
/// platform verifiers often report only "not trusted".
fn classify(
    error: &rustls::Error,
    details: &CertificateDetails,
    server_name: &ServerName<'_>,
    now: UnixTime,
) -> &'static str {
    match error {
        rustls::Error::InvalidCertificate(
            CertificateError::Expired | CertificateError::ExpiredContext { .. },
        ) => return "expired",
        rustls::Error::InvalidCertificate(
            CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. },
        ) => return "notYetValid",
        rustls::Error::InvalidCertificate(
            CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. },
        ) => return "hostname",
        _ => {}
    }
    let now = now.as_secs() as i64;
    let parse = |value: &Option<String>| {
        value
            .as_deref()
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
            .map(|time| time.timestamp())
    };
    if parse(&details.not_after).is_some_and(|end| now > end) {
        return "expired";
    }
    if parse(&details.not_before).is_some_and(|start| now < start) {
        return "notYetValid";
    }
    if !matches_name(details, server_name) {
        return "hostname";
    }
    match error {
        rustls::Error::InvalidCertificate(_) => "untrusted",
        _ => "invalid",
    }
}

fn matches_name(details: &CertificateDetails, server_name: &ServerName<'_>) -> bool {
    match server_name {
        ServerName::IpAddress(ip) => {
            let ip = IpAddr::from(*ip).to_string();
            details.ip_addresses.contains(&ip)
        }
        ServerName::DnsName(name) => {
            let name = name.as_ref().to_ascii_lowercase();
            details.dns_names.iter().any(|pattern| {
                let pattern = pattern.to_ascii_lowercase();
                match pattern.strip_prefix("*.") {
                    Some(suffix) => name
                        .split_once('.')
                        .is_some_and(|(label, rest)| !label.is_empty() && rest == suffix),
                    None => pattern == name,
                }
            })
        }
        _ => false,
    }
}

/// Reads the displayable fields of an X.509 certificate. Parsing is
/// best-effort: an unreadable field stays empty, verification is unaffected.
pub fn describe(certificate: &[u8], endpoint: &str, reason: &'static str) -> CertificateDetails {
    let mut details = CertificateDetails {
        endpoint: endpoint.to_string(),
        sha256: fingerprint(certificate),
        subject: String::new(),
        issuer: String::new(),
        not_before: None,
        not_after: None,
        dns_names: vec![],
        ip_addresses: vec![],
        reason,
        pinned_sha256: None,
    };
    let _ = der::read_certificate(certificate, &mut details);
    details
}

mod der {
    //! A minimal DER reader for the TBSCertificate fields shown to people.
    use super::CertificateDetails;

    struct Tlv<'a> {
        tag: u8,
        value: &'a [u8],
    }

    fn next<'a>(input: &mut &'a [u8]) -> Option<Tlv<'a>> {
        let (&tag, rest) = input.split_first()?;
        let (&first, mut rest) = rest.split_first()?;
        let length = if first < 0x80 {
            first as usize
        } else {
            let count = (first & 0x7f) as usize;
            if count == 0 || count > 4 || rest.len() < count {
                return None;
            }
            let length = rest[..count]
                .iter()
                .fold(0usize, |acc, byte| (acc << 8) | *byte as usize);
            rest = &rest[count..];
            length
        };
        if rest.len() < length {
            return None;
        }
        let (value, remaining) = rest.split_at(length);
        *input = remaining;
        Some(Tlv { tag, value })
    }

    fn name(mut input: &[u8]) -> String {
        let mut parts = vec![];
        while let Some(set) = next(&mut input) {
            let mut set_value = set.value;
            while let Some(attribute) = next(&mut set_value) {
                let mut attribute_value = attribute.value;
                let (Some(oid), Some(text)) =
                    (next(&mut attribute_value), next(&mut attribute_value))
                else {
                    continue;
                };
                let label = match oid.value {
                    [0x55, 0x04, 0x03] => "CN",
                    [0x55, 0x04, 0x0a] => "O",
                    [0x55, 0x04, 0x0b] => "OU",
                    [0x55, 0x04, 0x06] => "C",
                    _ => continue,
                };
                if let Ok(text) = std::str::from_utf8(text.value) {
                    parts.push(format!("{label}={text}"));
                }
            }
        }
        parts.join(", ")
    }

    fn time(tlv: &Tlv) -> Option<String> {
        let text = std::str::from_utf8(tlv.value).ok()?;
        let text = text.strip_suffix('Z')?;
        let full = match tlv.tag {
            // UTCTime: YYMMDDHHMMSS, years 50-99 are 19xx.
            0x17 if text.len() == 12 => {
                let year: u32 = text[..2].parse().ok()?;
                format!("{}{text}", if year >= 50 { "19" } else { "20" })
            }
            0x18 if text.len() == 14 => text.to_string(),
            _ => return None,
        };
        chrono::NaiveDateTime::parse_from_str(&full, "%Y%m%d%H%M%S")
            .ok()
            .map(|time| time.and_utc().to_rfc3339())
    }

    fn alternative_names(mut extensions: &[u8], details: &mut CertificateDetails) {
        while let Some(extension) = next(&mut extensions) {
            let mut fields = extension.value;
            let Some(oid) = next(&mut fields) else {
                continue;
            };
            if oid.value != [0x55, 0x1d, 0x11] {
                continue;
            }
            let mut value = next(&mut fields);
            if value.as_ref().is_some_and(|v| v.tag == 0x01) {
                value = next(&mut fields); // critical flag
            }
            let Some(octets) = value else { continue };
            let mut sequence = octets.value;
            let Some(names) = next(&mut sequence) else {
                continue;
            };
            let mut names = names.value;
            while let Some(general) = next(&mut names) {
                match general.tag {
                    0x82 => {
                        if let Ok(text) = std::str::from_utf8(general.value) {
                            details.dns_names.push(text.to_string());
                        }
                    }
                    0x87 => match general.value.len() {
                        4 => details.ip_addresses.push(
                            std::net::Ipv4Addr::from(<[u8; 4]>::try_from(general.value).unwrap())
                                .to_string(),
                        ),
                        16 => details.ip_addresses.push(
                            std::net::Ipv6Addr::from(<[u8; 16]>::try_from(general.value).unwrap())
                                .to_string(),
                        ),
                        _ => {}
                    },
                    _ => {}
                }
            }
        }
    }

    pub fn read_certificate(mut input: &[u8], details: &mut CertificateDetails) -> Option<()> {
        let certificate = next(&mut input)?;
        let mut certificate = certificate.value;
        let tbs = next(&mut certificate)?;
        let mut tbs = tbs.value;
        let mut field = next(&mut tbs)?;
        if field.tag == 0xa0 {
            field = next(&mut tbs)?; // version, then the serial number
        }
        let _serial = field;
        let _signature = next(&mut tbs)?;
        details.issuer = name(next(&mut tbs)?.value);
        let validity = next(&mut tbs)?;
        let mut validity = validity.value;
        details.not_before = next(&mut validity).and_then(|t| time(&t));
        details.not_after = next(&mut validity).and_then(|t| time(&t));
        details.subject = name(next(&mut tbs)?.value);
        let _key = next(&mut tbs)?;
        while let Some(item) = next(&mut tbs) {
            if item.tag == 0xa3 {
                let mut wrapper = item.value;
                if let Some(extensions) = next(&mut wrapper) {
                    alternative_names(extensions.value, details);
                }
            }
        }
        Some(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ftp::test_certs::{self_signed, TestCa};

    #[test]
    fn certificate_details_describe_subject_validity_and_names() {
        let ca = TestCa::new();
        let leaf = ca.leaf(&["localhost", "127.0.0.1"], false);
        let details = describe(&leaf.chain[0], "localhost:21", "untrusted");
        assert_eq!(details.sha256, fingerprint(&leaf.chain[0]));
        assert_eq!(details.sha256.len(), 64);
        assert!(details.subject.contains("CN=localhost"));
        assert!(details.issuer.contains("CN=Vesperwind Test CA"));
        assert_eq!(
            details.not_before.as_deref(),
            Some("2026-01-01T00:00:00+00:00")
        );
        assert_eq!(
            details.not_after.as_deref(),
            Some("2027-03-01T00:00:00+00:00")
        );
        assert_eq!(details.dns_names, ["localhost"]);
        assert_eq!(details.ip_addresses, ["127.0.0.1"]);
        assert!(describe(b"not a certificate", "h:1", "invalid")
            .subject
            .is_empty());
    }

    #[test]
    fn names_and_wildcards_match_like_tls() {
        let details = CertificateDetails {
            dns_names: vec!["*.example.test".into(), "exact.test".into()],
            ip_addresses: vec!["192.0.2.1".into()],
            ..describe(&self_signed(&["x"]).chain[0], "h:1", "untrusted")
        };
        let name = |value: &str| ServerName::try_from(value.to_string()).unwrap();
        assert!(matches_name(&details, &name("a.example.test")));
        assert!(!matches_name(&details, &name("a.b.example.test")));
        assert!(!matches_name(&details, &name("example.test")));
        assert!(matches_name(&details, &name("EXACT.test")));
        assert!(matches_name(&details, &name("192.0.2.1")));
        assert!(!matches_name(&details, &name("192.0.2.2")));
    }
}
