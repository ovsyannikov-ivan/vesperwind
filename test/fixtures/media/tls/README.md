# Loopback TLS fixture

These CA/certificate/key files are public, disposable test material for the
Node HTTPS fixture server. They are never used by the application or installed
in an OS trust store. The leaf expires on 2027-10-04; regenerate before expiry.
Apple SecureTransport requires a short-lived leaf with serverAuth and SANs.

From a temporary directory, generate a new test CA and 365-day leaf with the
test toolchain's OpenSSL-compatible CLI, then copy only ca.pem, cert.pem and
key.pem to fixture-ca.pem, fixture-cert.pem and fixture-key.pem:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -keyout ca-key.pem -out ca.pem -subj '/CN=Vesperwind fixture CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -newkey rsa:2048 -nodes -sha256 -keyout key.pem \
  -out request.pem -subj '/CN=localhost'
cat > extensions.txt <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
EXT
openssl x509 -req -in request.pem -CA ca.pem -CAkey ca-key.pem \
  -CAcreateserial -out cert.pem -days 365 -sha256 -extfile extensions.txt
```

The CA signing key is unnecessary at runtime and is not checked in. This is a
test fixture generation tool, not an application dependency.
