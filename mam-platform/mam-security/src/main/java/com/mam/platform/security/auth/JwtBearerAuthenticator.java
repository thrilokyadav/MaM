/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.security.auth;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.apache.commons.lang3.StringUtils;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.ecm.core.api.DocumentModel;
import org.nuxeo.ecm.core.api.NuxeoException;
import org.nuxeo.ecm.platform.api.login.UserIdentificationInfo;
import org.nuxeo.ecm.platform.ui.web.auth.interfaces.NuxeoAuthenticationPlugin;
import org.nuxeo.ecm.platform.usermanager.UserConfig;
import org.nuxeo.ecm.platform.usermanager.UserManager;
import org.nuxeo.runtime.api.Framework;
import org.nuxeo.runtime.services.config.ConfigurationService;

import com.auth0.jwt.interfaces.DecodedJWT;

/**
 * {@link NuxeoAuthenticationPlugin} that authenticates requests carrying an
 * {@code Authorization: Bearer <jwt>} header, per the "MAM Priority 2:
 * Production Authentication (OIDC/SSO)" requirements.
 *
 * <p>
 * This plugin is the Resource Server side of the OIDC flow: the browser
 * (mam-web, via {@code react-oidc-context}/{@code oidc-client-ts}) performs
 * the interactive login against the customer's IdP and calls the Nuxeo REST
 * API with the resulting {@code access_token} as a Bearer token. This
 * plugin never talks to the IdP's authorization/token endpoints itself; it
 * only <em>validates</em> the JWT (signature, issuer, audience, expiration —
 * see {@link JwtClaimsVerifier}) and resolves the corresponding Nuxeo
 * principal.
 * </p>
 *
 * <p>
 * <b>Claim-to-group mapping.</b> On every successful verification, the
 * configured groups/roles claim (default {@code groups}, overridable via
 * {@code mam.jwt.groups.claim}) is read from the token and the resulting
 * list of external role names is translated 1:1 onto MAM's internal groups
 * ({@code mam-producers}, {@code mam-editors}, {@code mam-archivists},
 * {@code administrators}) via the {@code mam.jwt.group.map.<claim-value>}
 * property (e.g. {@code mam.jwt.group.map.mam-editor=mam-editors}). Entries
 * with no configured mapping are ignored — the IdP's claim vocabulary does
 * not need to exactly match Nuxeo's group names. The resulting group set is
 * written onto the Nuxeo user record so standard ACL/permission checks
 * (including {@code ArchiveStateGuardListener} and the MAM_* permission
 * bundles) keep working unmodified; this plugin performs no authorization
 * itself, only identity + group provisioning.
 * </p>
 *
 * <p>
 * <b>Principal resolution.</b> The JWT {@code sub} claim (or, if configured
 * via {@code mam.jwt.username.claim}, another claim such as
 * {@code preferred_username}) is used as the Nuxeo username. If no user
 * with that name exists yet, one is created (JIT provisioning) with no
 * usable password — Bearer-token users can never authenticate with Basic
 * auth, by construction. Group membership is refreshed on every request so
 * a change on the IdP side (e.g. removing someone from mam-archivists)
 * takes effect immediately, without waiting for any local cache to expire.
 * </p>
 */
public class JwtBearerAuthenticator implements NuxeoAuthenticationPlugin {

    private static final Logger log = LogManager.getLogger(JwtBearerAuthenticator.class);

    public static final String PROP_GROUPS_CLAIM = "mam.jwt.groups.claim";

    public static final String DEFAULT_GROUPS_CLAIM = "groups";

    public static final String PROP_USERNAME_CLAIM = "mam.jwt.username.claim";

    public static final String PROP_GROUP_MAP_PREFIX = "mam.jwt.group.map.";

    public static final String ADMINISTRATORS_GROUP = "administrators";

    protected static final String BEARER_PREFIX = "Bearer ";

    protected final JwtClaimsVerifier verifier = new JwtClaimsVerifier();

    @Override
    public void initPlugin(Map<String, String> parameters) {
        // Configuration is read live from Nuxeo's ConfigurationService on
        // every request so it can be changed without a redeploy; nothing to
        // cache here at plugin-init time.
    }

    @Override
    public List<String> getUnAuthenticatedURLPrefix() {
        return null; // NOSONAR - no special unauthenticated URLs
    }

    @Override
    public Boolean needLoginPrompt(HttpServletRequest httpRequest) {
        return Boolean.FALSE;
    }

    @Override
    public Boolean handleLoginPrompt(HttpServletRequest httpRequest, HttpServletResponse httpResponse,
            String baseURL) {
        return Boolean.FALSE;
    }

    @Override
    public UserIdentificationInfo handleRetrieveIdentity(HttpServletRequest request, HttpServletResponse response) {
        String token = retrieveToken(request);
        if (token == null) {
            return null;
        }
        DecodedJWT jwt = verifier.verify(token);
        if (jwt == null) {
            log.debug("Bearer token present but failed verification");
            return null;
        }
        String username = resolveUsername(jwt);
        if (username == null) {
            log.debug("Bearer token verified but has no usable subject/username claim");
            return null;
        }
        List<String> externalGroups = JwtClaimsVerifier.getStringListClaim(jwt, groupsClaimName());
        Set<String> mamGroups = mapExternalGroups(externalGroups);
        Framework.doPrivileged(() -> provisionPrincipal(username, mamGroups));

        UserIdentificationInfo info = new UserIdentificationInfo(username);
        info.setToken(token);
        return info;
    }

    protected String retrieveToken(HttpServletRequest request) {
        String auth = request.getHeader("Authorization");
        if (auth == null || !auth.startsWith(BEARER_PREFIX)) {
            return null;
        }
        String token = auth.substring(BEARER_PREFIX.length()).trim();
        return token.isEmpty() ? null : token;
    }

    protected String resolveUsername(DecodedJWT jwt) {
        ConfigurationService config = Framework.getService(ConfigurationService.class);
        String usernameClaim = config.getProperty(PROP_USERNAME_CLAIM, null);
        String username = null;
        if (StringUtils.isNotBlank(usernameClaim)) {
            username = jwt.getClaim(usernameClaim).asString();
        }
        if (StringUtils.isBlank(username)) {
            username = jwt.getSubject();
        }
        return StringUtils.isBlank(username) ? null : username;
    }

    protected String groupsClaimName() {
        ConfigurationService config = Framework.getService(ConfigurationService.class);
        String claim = config.getProperty(PROP_GROUPS_CLAIM, null);
        return StringUtils.isNotBlank(claim) ? claim : DEFAULT_GROUPS_CLAIM;
    }

    /**
     * Translates external (IdP-side) role/group names to MAM's internal
     * group names using {@code mam.jwt.group.map.<external-name>} properties.
     * Unmapped external names are ignored (not passed through verbatim) so
     * an IdP claim can never grant membership in a Nuxeo group MAM did not
     * explicitly opt in to mapping.
     */
    protected Set<String> mapExternalGroups(List<String> externalGroups) {
        ConfigurationService config = Framework.getService(ConfigurationService.class);
        Set<String> mapped = new HashSet<>();
        for (String external : externalGroups) {
            if (StringUtils.isBlank(external)) {
                continue;
            }
            String mappedGroup = config.getProperty(PROP_GROUP_MAP_PREFIX + external, null);
            if (StringUtils.isNotBlank(mappedGroup)) {
                mapped.add(mappedGroup);
            }
        }
        return mapped;
    }

    /**
     * Creates the Nuxeo user if it doesn't exist yet (JIT provisioning) and
     * synchronizes its group membership to exactly the set resolved from the
     * token's claims for this request. Must run as an already-privileged
     * caller (see {@link Framework#doPrivileged}) since {@link UserManager}
     * writes require it outside of a normal authenticated session (we are,
     * after all, in the middle of establishing one).
     */
    protected void provisionPrincipal(String username, Set<String> mamGroups) {
        UserManager userManager = Framework.getService(UserManager.class);
        if (userManager == null) {
            throw new NuxeoException("UserManager service unavailable");
        }
        DocumentModel userModel = userManager.getUserModel(username);
        List<String> groups = new ArrayList<>(mamGroups);
        if (userModel == null) {
            userModel = userManager.getBareUserModel();
            userModel.setPropertyValue(userManager.getUserIdField(), username);
            userModel.setProperty(userManager.getUserSchemaName(), UserConfig.GROUPS_COLUMN, groups);
            // No password is ever set: Bearer-provisioned accounts cannot be
            // used to log in via BASIC_AUTH or FORM_AUTH, only via a valid JWT.
            userManager.createUser(userModel);
            log.info("JIT-provisioned Nuxeo user '{}' from JWT Bearer token with groups {}", username, groups);
        } else {
            @SuppressWarnings("unchecked")
            List<String> currentGroups = (List<String>) userModel.getProperty(userManager.getUserSchemaName(),
                    UserConfig.GROUPS_COLUMN);
            if (currentGroups == null || !new HashSet<>(currentGroups).equals(mamGroups)) {
                userModel.setProperty(userManager.getUserSchemaName(), UserConfig.GROUPS_COLUMN, groups);
                userManager.updateUser(userModel);
                log.debug("Synced groups for '{}' from JWT claims: {}", username, groups);
            }
        }
    }

}
