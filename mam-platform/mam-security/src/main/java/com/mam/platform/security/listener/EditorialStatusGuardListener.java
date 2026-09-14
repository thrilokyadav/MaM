/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.security.listener;

import java.io.Serializable;
import java.util.Objects;
import java.util.Set;

import org.nuxeo.ecm.core.api.CoreSession;
import org.nuxeo.ecm.core.api.DocumentModel;
import org.nuxeo.ecm.core.api.DocumentSecurityException;
import org.nuxeo.ecm.core.api.NuxeoPrincipal;
import org.nuxeo.ecm.core.api.event.CoreEventConstants;
import org.nuxeo.ecm.core.event.Event;
import org.nuxeo.ecm.core.event.EventListener;
import org.nuxeo.ecm.core.event.impl.DocumentEventContext;

/**
 * Server-enforced guard on {@code broadcast:editorialStatus}.
 *
 * <p>
 * Before this listener existed, {@code broadcast:editorialStatus} had no
 * server-side protection at all: any caller holding plain {@code Write} on
 * a document could set it to any value, including {@code approved},
 * completely bypassing the {@code MAM_EDITORIAL_APPROVAL} workflow
 * (Submit &rarr; Quality Control &rarr; Editorial Approval). Confirmed
 * directly against a running server: a {@code mam-producers} member could
 * PUT {@code broadcast:editorialStatus=approved} on their own asset and it
 * was accepted with no check. This is the fix for that gap, structured as
 * the direct counterpart to {@link ArchiveStateGuardListener}.
 * </p>
 *
 * <p>
 * Unlike the archive guard, this listener cannot simply allowlist a single
 * group: {@code mam-workflow}'s route model (see {@code
 * mam-workflow-contrib.xml}'s {@code mam_setEditorialStatus_*} automation
 * chains) writes this property under the acting user's own real
 * {@link NuxeoPrincipal} &mdash; the workflow engine does not run as a
 * system/privileged session. So "is this the workflow" cannot be
 * distinguished from "is this a raw PUT" by principal alone; both arrive
 * here identically. Instead, each transition is gated by the same MAM
 * permission the corresponding workflow task button already requires,
 * checked via {@link CoreSession#hasPermission(org.nuxeo.ecm.core.api.DocumentRef, String)}
 * on the document itself:
 * </p>
 * <ul>
 * <li>{@code draft} / {@code qc} &mdash; requires {@code MAM_SubmitForReview}
 * (granted to {@code mam-producers} via {@code MAM_ProducerAccess}; this is
 * also the permission the "Submit for review" / "Submit to Editorial"
 * actions already require in the client).</li>
 * <li>{@code approved} / {@code rejected} &mdash; requires {@code MAM_Approve}
 * for {@code approved}, {@code MAM_Reject} for {@code rejected} (both
 * granted to {@code mam-editors} via {@code MAM_EditorAccess}).</li>
 * </ul>
 * <p>
 * Because legitimate workflow-driven writes happen under the same
 * principal that is also the task's assigned actor (Nuxeo's routing engine
 * will not let someone who isn't the task actor complete it in the first
 * place), and that actor's group already holds the matching permission via
 * the ACL grants above, real workflow transitions pass this check
 * transparently. A direct API write from a principal who does NOT hold the
 * matching permission &mdash; e.g. a producer trying to self-approve their
 * own submission &mdash; is rejected with the same 403 contract as the
 * archive guard.
 * </p>
 *
 * <p>
 * Administrator always passes, mirroring {@link ArchiveStateGuardListener}.
 * </p>
 */
public class EditorialStatusGuardListener implements EventListener {

    protected static final String EDITORIAL_STATUS_PROPERTY = "broadcast:editorialStatus";

    protected static final String DRAFT = "draft";

    protected static final String QC = "qc";

    protected static final String APPROVED = "approved";

    protected static final String REJECTED = "rejected";

    /** The only values this addon's workflow ever legitimately writes. */
    protected static final Set<String> KNOWN_VALUES = Set.of(DRAFT, QC, APPROVED, REJECTED);

    public static final String PERMISSION_SUBMIT_FOR_REVIEW = "MAM_SubmitForReview";

    public static final String PERMISSION_APPROVE = "MAM_Approve";

    public static final String PERMISSION_REJECT = "MAM_Reject";

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

        DocumentModel previous = (DocumentModel) context.getProperty(CoreEventConstants.PREVIOUS_DOCUMENT_MODEL);
        if (previous == null || !previous.hasSchema("broadcast")) {
            // No previous state to compare against: this is document
            // CREATION (aboutToCreate). Close the create-time bypass — a
            // non-Administrator must not be able to create an asset that is
            // ALREADY in a privileged editorial state (e.g.
            // editorialStatus="approved"), which would skip the whole
            // MAM_EDITORIAL_APPROVAL workflow. The only editorial states a
            // non-admin may set at creation are "none" (null/blank, the
            // normal upload path — see UploadPage.tsx) or "draft" (the
            // pre-submission state). Administrator is exempt: the
            // AdministratorAutoApproveListener legitimately stamps
            // "approved" on admin-created assets.
            guardCreation(event, doc, principal);
            return;
        }

        Serializable before = previous.getPropertyValue(EDITORIAL_STATUS_PROPERTY);
        Serializable after = doc.getPropertyValue(EDITORIAL_STATUS_PROPERTY);
        if (Objects.equals(before, after)) {
            return;
        }

        if (principal == null || principal.isAdministrator()) {
            return;
        }

        String requiredPermission = requiredPermissionFor(after);
        if (requiredPermission == null) {
            // Not one of the four values this workflow ever writes (e.g.
            // some future/unexpected value). Fail closed rather than
            // silently allow an unrecognised transition.
            denyChange(event, principal, String.valueOf(after),
                    "is not a recognised broadcast:editorialStatus value");
            return;
        }

        CoreSession session = context.getCoreSession();
        boolean allowed = session != null && session.hasPermission(doc.getRef(), requiredPermission);
        if (!allowed) {
            denyChange(event, principal, String.valueOf(after),
                    "requires the " + requiredPermission + " permission on this asset");
        }
    }

    /**
     * Enforces the create-time rule: a non-Administrator may only create a
     * broadcast asset with {@code editorialStatus} unset (null/blank) or
     * {@code "draft"}. Any privileged initial state ({@code qc},
     * {@code approved}, {@code rejected}, or any unrecognised value) is
     * rejected with the same 403 contract as an illegitimate transition,
     * closing the "create already-approved to skip the workflow" bypass.
     * Administrator is exempt (auto-approve stamps {@code approved}).
     */
    protected void guardCreation(Event event, DocumentModel doc, NuxeoPrincipal principal) {
        if (principal == null || principal.isAdministrator()) {
            return;
        }
        Serializable initial = doc.getPropertyValue(EDITORIAL_STATUS_PROPERTY);
        if (initial == null) {
            return;
        }
        String value = String.valueOf(initial);
        if (value.isBlank() || DRAFT.equals(value)) {
            return;
        }
        denyChange(event, principal, value,
                "a new asset may only be created with editorial status unset or 'draft'");
    }

    /**
     * The permission a caller must hold on the document to legitimately
     * move {@code broadcast:editorialStatus} to {@code targetValue}, or
     * {@code null} if {@code targetValue} is not one of the four values
     * this addon's workflow ever writes.
     */
    protected String requiredPermissionFor(Serializable targetValue) {
        if (!(targetValue instanceof String value) || !KNOWN_VALUES.contains(value)) {
            return null;
        }
        return switch (value) {
            case DRAFT, QC -> PERMISSION_SUBMIT_FOR_REVIEW;
            case APPROVED -> PERMISSION_APPROVE;
            case REJECTED -> PERMISSION_REJECT;
            default -> null;
        };
    }

    protected void denyChange(Event event, NuxeoPrincipal principal, String attemptedValue, String reason) {
        DocumentSecurityException denied = new DocumentSecurityException(
                "Cannot set " + EDITORIAL_STATUS_PROPERTY + " to '" + attemptedValue + "': " + reason + ".");
        // A synchronous listener throwing is, by itself, not enough:
        // EventServiceImpl#fireEvent swallows RuntimeExceptions from sync
        // listeners unless the event is explicitly marked for rollback.
        // markRollBack ensures this denial actually aborts the save and
        // propagates to the caller as a real 403 instead of being logged
        // and silently ignored. Mirrors ArchiveStateGuardListener exactly.
        event.markRollBack(denied.getMessage(), denied);
        throw denied;
    }

}
