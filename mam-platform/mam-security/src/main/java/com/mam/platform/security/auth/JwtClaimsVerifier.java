/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.security.auth;

import java.security.interfaces.RSAPublicKey;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import org.apache.commons.lang3.StringUtils;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.runtime.api.Framework;
import org.nuxeo.runtime.services.config.ConfigurationService;

import com.auth0.jwk.Jwk;
import com.auth0.jwk.JwkException;
import com.auth0.jwk.JwkProvider;
import com.auth0.jwk.JwkProviderBuilder;
import com.auth0.jwt.JWT;
import com.auth0.jwt.algorithms.Algorithm;
import com.auth0.jwt.exceptions.JWTVerificationException;
import com.auth0.jwt.interfaces.DecodedJWT;
import com.auth0.jwt.interfaces.JWTVerifier;

/**
 * Verifies OIDC/OAuth2 JWT Bearer tokens presented to the MAM REST API.
 *
 * <p>
 * Two verification modes are supported, both configured exclusively via
 * Nuxeo's {@code ConfigurationService} ({@code nuxeo.conf} properties, or
 * an OSGI {@code configuration} extension contribution such as
 * mam-jwt-auth-contrib.xml / the smoke image's mam-jwt-smoke-config.xml;
 * never hardcoded, never shipped with a default secret):
 * <ul>
 * <li><b>RS256 / JWKS</b> (production): set {@code mam.jwt.jwks.url} to the
 * IdP's JSON Web Key Set endpoint (e.g.
 * {@code https://idp.example.com/.well-known/jwks.json}). Signature
 * verification fetches (and caches) the matching public key by {@code kid}.
 * This is the mode a real OIDC provider (Keycloak, Auth0, Okta, Dex, Azure
 * AD, ...) is expected to use.</li>
 * <li><b>HS256 / shared secret</b> (smoke / dev only): set
 * {@code mam.jwt.hmac.secret}. Intended for the disposable smoke-test
 * harness, which mints its own tokens; never set this in a real
 * deployment.</li>
 * </ul>
 * If neither property is configured, {@link #verify(String)} always returns
 * {@code null} (no token can ever verify), so simply not configuring this
 * feature disables JWT Bearer auth entirely without any code change.
 * </p>
 *
 * <p>
 * {@code mam.jwt.issuer} and {@code mam.jwt.audience}, when set, are
 * enforced as exact-match {@code iss} / {@code aud} claims. Expiration
 * ({@code exp}) is always enforced by the underlying verifier.
 * </p>
 */
public class JwtClaimsVerifier {

    private static final Logger log = LogManager.getLogger(JwtClaimsVerifier.class);

    public static final String PROP_ISSUER = "mam.jwt.issuer";

    public static final String PROP_AUDIENCE = "mam.jwt.audience";

    public static final String PROP_JWKS_URL = "mam.jwt.jwks.url";

    public static final String PROP_HMAC_SECRET = "mam.jwt.hmac.secret";

    /** JWKS keys are cached for this long before a re-fetch is attempted. */
    protected static final long JWKS_CACHE_SIZE = 10;

    protected static final long JWKS_CACHE_TTL_MINUTES = 10;

    protected volatile JwkProvider jwkProvider;

    protected volatile String cachedJwksUrl;

    /**
     * Verifies the token's signature and standard claims (issuer, audience,
     * expiration). Returns the decoded claims as a simple map, or
     * {@code null} if the token is missing, malformed, unverifiable, or
     * JWT Bearer auth is not configured at all.
     */
    public DecodedJWT verify(String token) {
        if (StringUtils.isBlank(token)) {
            return null;
        }
        ConfigurationService config = Framework.getService(ConfigurationService.class);
        String issuer = config.getProperty(PROP_ISSUER, null);
        String audience = config.getProperty(PROP_AUDIENCE, null);
        Algorithm algorithm = resolveAlgorithm(token);
        if (algorithm == null) {
            log.debug("JWT Bearer auth not configured (no JWKS url or HMAC secret); rejecting token");
            return null;
        }
        try {
            var verifierBuilder = JWT.require(algorithm);
            if (StringUtils.isNotBlank(issuer)) {
                verifierBuilder = verifierBuilder.withIssuer(issuer);
            }
            if (StringUtils.isNotBlank(audience)) {
                verifierBuilder = verifierBuilder.withAudience(audience);
            }
            JWTVerifier verifier = verifierBuilder.build();
            return verifier.verify(token);
        } catch (JWTVerificationException e) {
            log.debug("JWT verification failed: {}", e::toString);
            return null;
        }
    }

    /**
     * Picks the verification algorithm based on the token's own {@code alg}/
     * {@code kid} header and the server's configuration. RS256 tokens are
     * verified against the configured JWKS endpoint; HS256 tokens are
     * verified against the configured shared secret. Any other algorithm,
     * or a token whose required configuration is absent, is rejected by
     * returning {@code null}.
     */
    protected Algorithm resolveAlgorithm(String token) {
        DecodedJWT unverified;
        try {
            unverified = JWT.decode(token);
        } catch (JWTVerificationException e) {
            log.debug("Cannot decode JWT header: {}", e::toString);
            return null;
        }
        String alg = unverified.getAlgorithm();
        ConfigurationService config = Framework.getService(ConfigurationService.class);
        if ("RS256".equals(alg)) {
            String jwksUrl = config.getProperty(PROP_JWKS_URL, null);
            if (StringUtils.isBlank(jwksUrl)) {
                return null;
            }
            String kid = unverified.getKeyId();
            if (StringUtils.isBlank(kid)) {
                log.debug("RS256 token missing 'kid' header, cannot select JWKS key");
                return null;
            }
            try {
                Jwk jwk = getJwkProvider(jwksUrl).get(kid);
                return Algorithm.RSA256((RSAPublicKey) jwk.getPublicKey(), null);
            } catch (JwkException e) {
                log.debug("Unable to resolve JWKS key '{}': {}", kid, e.toString());
                return null;
            }
        }
        if ("HS256".equals(alg)) {
            String secret = config.getProperty(PROP_HMAC_SECRET, null);
            if (StringUtils.isBlank(secret)) {
                return null;
            }
            return Algorithm.HMAC256(secret);
        }
        log.debug("Unsupported JWT algorithm: {}", alg);
        return null;
    }

    protected JwkProvider getJwkProvider(String jwksUrl) {
        JwkProvider provider = jwkProvider;
        if (provider == null || !jwksUrl.equals(cachedJwksUrl)) {
            synchronized (this) {
                if (jwkProvider == null || !jwksUrl.equals(cachedJwksUrl)) {
                    jwkProvider = new JwkProviderBuilder(jwksUrl).cached(JWKS_CACHE_SIZE, JWKS_CACHE_TTL_MINUTES,
                            TimeUnit.MINUTES).build();
                    cachedJwksUrl = jwksUrl;
                }
                provider = jwkProvider;
            }
        }
        return provider;
    }

    /** Reads a claim as a flat list of Strings, regardless of the claim's underlying JSON shape. */
    public static java.util.List<String> getStringListClaim(DecodedJWT jwt, String claimName) {
        var claim = jwt.getClaim(claimName);
        if (claim == null || claim.isNull()) {
            return java.util.List.of();
        }
        java.util.List<String> asList = claim.asList(String.class);
        if (asList != null) {
            return asList;
        }
        String single = claim.asString();
        return single == null ? java.util.List.of() : java.util.List.of(single);
    }

    /** Convenience accessor used by tests / diagnostics. */
    public static Map<String, Object> claimsAsMap(DecodedJWT jwt) {
        Map<String, Object> map = new java.util.HashMap<>();
        jwt.getClaims().forEach((k, v) -> map.put(k, v.as(Object.class)));
        return map;
    }

}
