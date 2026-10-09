//! Synthetic test PKI for FTPS tests: a private CA and leaf certificates
//! (valid, expired, wrong host, self-signed). Never used outside tests.
use rcgen::{
    date_time_ymd, BasicConstraints, CertificateParams, DistinguishedName, DnType,
    ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

pub struct TestCa {
    pub der: CertificateDer<'static>,
    issuer: Issuer<'static, KeyPair>,
}

pub struct Leaf {
    pub chain: Vec<CertificateDer<'static>>,
    pub key: PrivateKeyDer<'static>,
}

fn named(name: &str) -> DistinguishedName {
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, name);
    dn.push(DnType::OrganizationName, "Vesperwind Test");
    dn
}

impl TestCa {
    pub fn new() -> Self {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.distinguished_name = named("Vesperwind Test CA");
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        params.not_before = date_time_ymd(2025, 1, 1);
        params.not_after = date_time_ymd(2030, 1, 1);
        let der = params.self_signed(&key).unwrap().der().clone();
        Self {
            der,
            issuer: Issuer::new(params, key),
        }
    }

    pub fn leaf(&self, names: &[&str], expired: bool) -> Leaf {
        let (params, key) = leaf_params(names, expired);
        let certificate = params.signed_by(&key, &self.issuer).unwrap();
        Leaf {
            chain: vec![certificate.der().clone(), self.der.clone()],
            key: PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
        }
    }
}

fn leaf_params(names: &[&str], expired: bool) -> (CertificateParams, KeyPair) {
    let key = KeyPair::generate().unwrap();
    let mut params =
        CertificateParams::new(names.iter().map(|n| n.to_string()).collect::<Vec<_>>()).unwrap();
    params.distinguished_name = named(names.first().copied().unwrap_or("test"));
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    // Within Apple's validity limits for trusted server certificates.
    if expired {
        params.not_before = date_time_ymd(2024, 1, 1);
        params.not_after = date_time_ymd(2024, 6, 1);
    } else {
        params.not_before = date_time_ymd(2026, 1, 1);
        params.not_after = date_time_ymd(2027, 3, 1);
    }
    (params, key)
}

/// A self-signed leaf that no trust store knows.
pub fn self_signed(names: &[&str]) -> Leaf {
    let (params, key) = leaf_params(names, false);
    let certificate = params.self_signed(&key).unwrap();
    Leaf {
        chain: vec![certificate.der().clone()],
        key: PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
    }
}
