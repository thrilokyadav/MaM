/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.security.listener;

import java.io.Serializable;
import java.util.Date;
import java.util.Objects;

import org.nuxeo.ecm.core.api.DocumentModel;
import org.nuxeo.ecm.core.api.DocumentSecurityException;
import org.nuxeo.ecm.core.api.NuxeoPrincipal;
import org.nuxeo.ecm.core.api.event.CoreEventConstants;
import org.nuxeo.ecm.core.event.Event;
import org.nuxeo.ecm.core.event.EventListener;
import org.nuxeo.ecm.core.event.impl.DocumentEventContext;

/**
 * Server-enforced guard on {@code broadcast:archiveState}.
 *
 * <p>
 * Only members of the {@code mam-archivists} group, or Administrator, may
 * change this field, regardless of standard {@code Write}/{@code WriteProperties}
 * permission. This is deliberately NOT expressed as an ACL-based permission
 * check ({@code MAM_Archive} alone cannot do this): Nuxeo's ACL model grants
 * or denies access to a whole document, not to one property conditionally on
 * its new value. The smallest correct enforcement point for a "this one
 * field, only for this one group" rule is a synchronous core listener on the
 * {@code beforeDocumentModification} event, which fires for every code path
 * that calls {@code CoreSession#saveDocument} — REST PUT
 * ({@code JSONDocumentObject}), automation's {@code Document.SetProperty},
 * the Nuxeo Web UI, and any future caller alike. Throwing
 * {@link DocumentSecurityException} here aborts the save before commit and
 * is mapped to HTTP 403 by Nuxeo's standard exception handling
 * (see {@code DocumentSecurityException} extends {@code NuxeoException}
 * with status 403; {@code WebEngineExceptionMapper#getStatusCode} reads
 * {@code NuxeoException#getStatusCode()} for the REST response).
 * </p>
 *
 * <p>
 * Administrator always passes (checked explicitly here, mirroring the
 * built-in {@code Everything} shortcut used everywhere else in this addon)
 * so the "administrator can change archive states" requirement holds
 * without special-casing the archivist group check.
 * </p>
 */
public class ArchiveStateGuardListener implements EventListener {

    public static final String ARCHIVIST_GROUP = "mam-archivists";

    protected static final String ARCHIVE_STATE_PROPERTY = "broadcast:archiveState";

    protected static final String COLD_STATE = "cold";

    protected static final String HOT_STATE = "hot";

    protected static final String ARCHIVE_DATE_PROPERTY = "broadcast:archiveDate";

    protected static final String ARCHIVED_BY_PROPERTY = "broadcast:archivedBy";

    protected static final String RESTORE_DATE_PROPERTY = "broadcast:restoreDate";

    protected static final String RESTORED_BY_PROPERTY = "broadcast:restoredBy";

    @Override
    public void handleEvent(Event event) {
        if (!(event.getContext() instanceof DocumentEventContext context)) {
            return;
        }
        DocumentModel doc = context.getSourceDocument();
        if (doc == null || !doc.hasSchema("broadcast")) {
            return;
        }

        DocumentModel previous = (DocumentModel) context.getProperty(CoreEventConstants.PREVIOUS_DOCUMENT_MODEL);
        if (previous == null || !previous.hasSchema("broadcast")) {
            // No previous state to compare against (e.g. document creation,
            // aboutToCreate) — nothing to guard yet.
            return;
        }

        Serializable before = previous.getPropertyValue(ARCHIVE_STATE_PROPERTY);
        Serializable after = doc.getPropertyValue(ARCHIVE_STATE_PROPERTY);
        if (Objects.equals(before, after)) {
            return;
        }

        NuxeoPrincipal principal = context.getPrincipal();
        if (principal == null || principal.isAdministrator() || principal.isMemberOf(ARCHIVIST_GROUP)) {
            populateArchiveAuditFields(doc, after, principal);
            return;
        }

        DocumentSecurityException denied = new DocumentSecurityException(
                "Only members of the " + ARCHIVIST_GROUP + " group or an administrator may change "
                        + ARCHIVE_STATE_PROPERTY + ".");
        // A synchronous listener throwing is, by itself, not enough:
        // EventServiceImpl#fireEvent swallows RuntimeExceptions from sync
        // listeners unless the event is explicitly marked for rollback (or
        // bubbleException). markRollBack ensures this denial actually
        // aborts the save and propagates to the caller instead of being
        // logged and silently ignored.
        event.markRollBack(denied.getMessage(), denied);
        throw denied;
    }

    /**
     * Stamps the archive audit trail fields ({@code broadcast:archiveDate}/
     * {@code archivedBy} on a transition to {@code "cold"},
     * {@code broadcast:restoreDate}/{@code restoredBy} on a transition to
     * {@code "hot"}) directly on the document being saved, before this
     * {@code beforeDocumentModification} listener returns. Because this
     * runs synchronously and before-save, the values are included in the
     * very same {@code CoreSession#saveDocument} call that changed
     * {@code archiveState} -- no second save, no extra event round-trip.
     * Only called once the caller has already been authorized to change
     * {@code archiveState} (Administrator or {@code mam-archivists}); any
     * other value change to {@code archiveState} (i.e. not exactly
     * {@code "hot"} or {@code "cold"}) is left alone, since this addon does
     * not yet define what auditing (if any) applies to other states.
     */
    protected void populateArchiveAuditFields(DocumentModel doc, Serializable newState, NuxeoPrincipal principal) {
        String username = principal == null ? null : principal.getName();
        if (COLD_STATE.equals(newState)) {
            doc.setPropertyValue(ARCHIVE_DATE_PROPERTY, new Date());
            doc.setPropertyValue(ARCHIVED_BY_PROPERTY, username);
        } else if (HOT_STATE.equals(newState)) {
            doc.setPropertyValue(RESTORE_DATE_PROPERTY, new Date());
            doc.setPropertyValue(RESTORED_BY_PROPERTY, username);
        }
    }

}
