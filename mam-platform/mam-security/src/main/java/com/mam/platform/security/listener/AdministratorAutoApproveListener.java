/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.security.listener;

import org.nuxeo.ecm.core.api.DocumentModel;
import org.nuxeo.ecm.core.api.NuxeoPrincipal;
import org.nuxeo.ecm.core.event.Event;
import org.nuxeo.ecm.core.event.EventListener;
import org.nuxeo.ecm.core.event.impl.DocumentEventContext;

/**
 * Auto-approves any {@code BroadcastAsset}/{@code BroadcastVideo} created
 * by an Administrator, skipping the normal {@code draft -&gt;
 * qc -&gt; approved} {@code MAM_EDITORIAL_APPROVAL} workflow entirely for
 * that principal.
 *
 * <p>
 * Registered on {@code aboutToCreate} (fires while the document is still
 * being built, before it is persisted), so this simply stamps
 * {@code broadcast:editorialStatus=approved} directly onto the in-flight
 * {@link DocumentModel} rather than performing a second save. Every other
 * creator (producers, editors, archivists) is left completely untouched:
 * their assets are still created with no editorial status at all, and
 * must go through "Submit for review" exactly as before &mdash; see
 * {@code UploadPage.tsx}'s comment on why {@code editorialStatus} is
 * deliberately absent from the upload form.
 * </p>
 *
 * <p>
 * This does not need to bypass {@link EditorialStatusGuardListener}: that
 * listener only compares a change against a PREVIOUS document model
 * ({@code CoreEventConstants#PREVIOUS_DOCUMENT_MODEL}), which does not
 * exist yet at document-creation time, so it already ignores the value
 * set here (see that class's Javadoc, "No previous state to compare
 * against (e.g. document creation)"). Administrator is additionally
 * exempt from that guard entirely on any later transition, so an
 * Administrator-created asset's {@code editorialStatus} can still be
 * freely changed afterward by the same principal.
 * </p>
 */
public class AdministratorAutoApproveListener implements EventListener {

    protected static final String EDITORIAL_STATUS_PROPERTY = "broadcast:editorialStatus";

    protected static final String APPROVED = "approved";

    @Override
    public void handleEvent(Event event) {
        if (!(event.getContext() instanceof DocumentEventContext context)) {
            return;
        }
        DocumentModel doc = context.getSourceDocument();
        if (doc == null || !doc.hasSchema("broadcast")) {
            return;
        }

        NuxeoPrincipal principal = context.getPrincipal();
        if (principal == null || !principal.isAdministrator()) {
            return;
        }

        // Only fill in the status when the caller didn't already set one
        // explicitly. mam-web's upload form never sets editorialStatus
        // (see UploadPage.tsx), so real end-user uploads always take this
        // path; anything that deliberately creates a document with an
        // explicit status (e.g. test fixtures building a "draft" asset as
        // Administrator to exercise a later transition) is left alone.
        if (doc.getPropertyValue(EDITORIAL_STATUS_PROPERTY) == null) {
            doc.setPropertyValue(EDITORIAL_STATUS_PROPERTY, APPROVED);
        }
    }

}
