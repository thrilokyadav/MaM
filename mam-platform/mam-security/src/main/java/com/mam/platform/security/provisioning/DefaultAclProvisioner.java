/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.security.provisioning;

import java.util.LinkedHashMap;
import java.util.Map;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.ecm.core.api.CoreInstance;
import org.nuxeo.ecm.core.api.CoreSession;
import org.nuxeo.ecm.core.api.DocumentModel;
import org.nuxeo.ecm.core.api.DocumentNotFoundException;
import org.nuxeo.ecm.core.api.DocumentRef;
import org.nuxeo.ecm.core.api.NuxeoException;
import org.nuxeo.ecm.core.api.PathRef;
import org.nuxeo.ecm.core.api.repository.RepositoryManager;
import org.nuxeo.ecm.core.api.security.ACE;
import org.nuxeo.ecm.core.api.security.ACL;
import org.nuxeo.ecm.core.api.security.ACP;
import org.nuxeo.runtime.api.Framework;
import org.nuxeo.runtime.model.ComponentContext;
import org.nuxeo.runtime.model.ComponentStartOrders;
import org.nuxeo.runtime.model.DefaultComponent;
import org.nuxeo.runtime.transaction.TransactionHelper;

/**
 * Grants the ACL every MAM role actually needs to use the application, on
 * every server start, so a fresh/reset database (a new deployment, or a
 * local {@code docker compose down -v}) never reproduces the
 * "AddChildren"/"Read" 403s a brand-new repository would otherwise start
 * with.
 *
 * <p>
 * Background: {@code mam-web}'s upload flow creates new documents directly
 * under {@code /default-domain/workspaces} (see
 * {@code VITE_MAM_INGEST_PATH}), but a freshly-initialized Nuxeo repository
 * only grants the built-in {@code members} group plain {@code Read} there
 * &mdash; nothing writes {@code Write}/{@code AddChildren} for any MAM role
 * by default. Producers (and, for the same reason, archivists/editors, who
 * also need to reach documents under this root to review/archive them)
 * would otherwise hit a 403 on their very first action, exactly as
 * observed in production testing with the {@code mam-producers} group.
 * </p>
 *
 * <p>
 * This is intentionally NOT expressed as a static {@code <ace>} XML
 * contribution: Nuxeo's core security extension points contribute
 * PERMISSION definitions and default root ACLs at the repository-type
 * level, not ad-hoc ACEs on a specific document path created by application
 * data (the {@code /default-domain/workspaces} folder is itself created by
 * the platform's own initial content, not by this addon). Granting an ACE
 * on a specific existing document is therefore necessarily an imperative,
 * session-based operation, run once the repository is guaranteed to exist.
 * </p>
 *
 * <p>
 * Runs on every {@link #start} (after {@link ComponentStartOrders#REPOSITORY},
 * so the target document is guaranteed to exist), but is idempotent: it
 * first checks whether the ACE is already present before adding it, so
 * repeated server restarts never accumulate duplicate ACEs and never touch
 * the ACP if nothing is missing.
 * </p>
 */
public class DefaultAclProvisioner extends DefaultComponent {

    private static final Logger log = LogManager.getLogger(DefaultAclProvisioner.class);

    /** Same value as {@code VITE_MAM_INGEST_PATH} in mam-web's .env files. */
    public static final String INGEST_ROOT_PATH = "/default-domain/workspaces";

    /**
     * Role groups (see {@code mam-security-contrib.xml}'s permission
     * bundles) that need to create, review, or manage documents under
     * {@link #INGEST_ROOT_PATH}, mapped to the exact role bundle each one
     * needs. Granting the full bundle (rather than a blanket {@code Write})
     * is required so that, e.g., producers actually receive
     * {@code MAM_SubmitForReview} and not just {@code Write} &mdash; a
     * previous version of this class granted plain {@code Write} to every
     * group, which left producers unable to submit assets for review since
     * {@code filter@MAM_EDITORIAL_APPROVAL} checks for
     * {@code MAM_SubmitForReview} specifically, not {@code Write}.
     *
     * <p>
     * Editors are included even though {@code MAM_EditorAccess} deliberately
     * excludes {@code Write} (see {@code EditorialStatusGuardListener}'s
     * Javadoc): the workflow engine completes their approve/reject task
     * under their own real principal, and Nuxeo's routing engine only
     * bypasses the core {@code WriteProperties} check for the specific task
     * update, not for general listing/read access to the folder tree, so
     * editors still need baseline access (granted here via
     * {@code MAM_EditorAccess}, which includes {@code Read}) to browse to
     * the asset they were assigned.
     * </p>
     */
    public static final Map<String, String> MAM_GROUP_PERMISSIONS;

    static {
        Map<String, String> groupPermissions = new LinkedHashMap<>();
        groupPermissions.put("mam-producers", "MAM_ProducerAccess");
        groupPermissions.put("mam-archivists", "MAM_ArchivistAccess");
        groupPermissions.put("mam-editors", "MAM_EditorAccess");
        MAM_GROUP_PERMISSIONS = groupPermissions;
    }

    @Override
    public int getApplicationStartedOrder() {
        return ComponentStartOrders.REPOSITORY + 20;
    }

    @Override
    public void start(ComponentContext context) {
        // CoreSession usage requires an active transaction; at
        // component-start time (before the very first request) none has
        // been opened yet, so this must open its own around the work.
        Framework.doPrivileged(() -> TransactionHelper.runInTransaction(this::provisionDefaultAcls));
    }

    protected void provisionDefaultAcls() {
        RepositoryManager repositoryManager = Framework.getService(RepositoryManager.class);
        if (repositoryManager == null) {
            log.warn("RepositoryManager unavailable; skipping default MAM ACL provisioning");
            return;
        }
        String repositoryName = repositoryManager.getDefaultRepositoryName();
        CoreSession session = CoreInstance.getCoreSessionSystem(repositoryName);
        DocumentRef ingestRoot = new PathRef(INGEST_ROOT_PATH);
        DocumentModel folder;
        try {
            folder = session.getDocument(ingestRoot);
        } catch (DocumentNotFoundException e) {
            // Nothing to provision yet (e.g. very first boot, before the
            // platform's own initial content creates this folder). A later
            // server restart will find it and provision normally.
            log.debug("Ingest root {} does not exist yet; skipping default MAM ACL provisioning",
                    INGEST_ROOT_PATH);
            return;
        } catch (NuxeoException e) {
            log.warn("Failed to look up ingest root {} for default MAM ACL provisioning: {}", INGEST_ROOT_PATH,
                    e.getMessage(), e);
            return;
        }

        ACP acp = session.getACP(folder.getRef());
        ACL localAcl = acp.getOrCreateACL(ACL.LOCAL_ACL);
        boolean changed = false;
        for (Map.Entry<String, String> entry : MAM_GROUP_PERMISSIONS.entrySet()) {
            String group = entry.getKey();
            String permission = entry.getValue();
            if (hasEffectiveGrant(localAcl, group, permission)) {
                continue;
            }
            localAcl.add(new ACE(group, permission, true));
            changed = true;
            log.info("Granted {} to {} on {} (default MAM ACL provisioning)", permission, group, INGEST_ROOT_PATH);
        }
        if (changed) {
            acp.addACL(localAcl);
            session.setACP(folder.getRef(), acp, true);
            session.save();
        }
    }

    /** Whether {@code group} already has a granting ACE for {@code permission} in {@code acl}. */
    protected boolean hasEffectiveGrant(ACL acl, String group, String permission) {
        for (ACE ace : acl.getACEs()) {
            if (ace.isGranted() && group.equals(ace.getUsername()) && permission.equals(ace.getPermission())) {
                return true;
            }
        }
        return false;
    }

}
