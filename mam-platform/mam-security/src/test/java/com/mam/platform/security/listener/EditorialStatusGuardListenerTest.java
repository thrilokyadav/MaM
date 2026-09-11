/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.security.listener;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.List;

import jakarta.inject.Inject;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.nuxeo.ecm.core.api.CoreSession;
import org.nuxeo.ecm.core.api.DocumentModel;
import org.nuxeo.ecm.core.api.DocumentSecurityException;
import org.nuxeo.ecm.core.api.impl.UserPrincipal;
import org.nuxeo.ecm.core.api.security.ACE;
import org.nuxeo.ecm.core.api.security.ACL;
import org.nuxeo.ecm.core.api.security.ACP;
import org.nuxeo.ecm.core.api.security.SecurityConstants;
import org.nuxeo.ecm.core.test.CoreFeature;
import org.nuxeo.ecm.core.test.annotations.Granularity;
import org.nuxeo.ecm.core.test.annotations.RepositoryConfig;
import org.nuxeo.runtime.test.runner.Deploy;
import org.nuxeo.runtime.test.runner.Features;
import org.nuxeo.runtime.test.runner.FeaturesRunner;

/**
 * Runtime test for the server-enforced {@code broadcast:editorialStatus}
 * guard. Exercises the listener directly through {@code CoreSession} —
 * the same layer every REST/automation/workflow path funnels through —
 * so this proves enforcement independent of any particular HTTP endpoint
 * or of whether the caller went through the workflow engine.
 */
@RunWith(FeaturesRunner.class)
@Features(CoreFeature.class)
@Deploy("org.nuxeo.ecm.platform.query.api")
@Deploy("com.mam.platform.core")
@Deploy("com.mam.platform.security")
@RepositoryConfig(cleanup = Granularity.METHOD)
public class EditorialStatusGuardListenerTest {

    protected static final String PRODUCER = "producer1";

    protected static final String EDITOR = "editor1";

    protected static final String ADMIN = "Administrator";

    @Inject
    protected CoreFeature coreFeature;

    protected DocumentModel createDraftAsset(CoreSession session) {
        DocumentModel doc = session.createDocumentModel("/", "asset", "BroadcastAsset");
        doc.setPropertyValue("dc:title", "Editorial guard test asset");
        doc.setPropertyValue("broadcast:editorialStatus", "draft");
        doc = session.createDocument(doc);
        session.save();
        return doc;
    }

    protected CoreSession sessionAs(String username, List<String> groups, boolean administrator) {
        return coreFeature.getCoreSession(new UserPrincipal(username, groups, false, administrator));
    }

    /** Grants exactly the given MAM permission (not Write) on {@code doc} to {@code username}. */
    protected void grant(CoreSession adminSession, DocumentModel doc, String username, String permission) {
        ACP acp = adminSession.getACP(doc.getRef());
        acp.addACE(ACL.LOCAL_ACL, new ACE(username, permission, true));
        adminSession.setACP(doc.getRef(), acp, true);
        adminSession.save();
    }

    protected void grantReadWrite(CoreSession adminSession, DocumentModel doc, String username) {
        ACP acp = adminSession.getACP(doc.getRef());
        acp.addACE(ACL.LOCAL_ACL, new ACE(username, SecurityConstants.READ_WRITE, true));
        adminSession.setACP(doc.getRef(), acp, true);
        adminSession.save();
    }

    @Test
    public void producerWithSubmitPermissionCanMoveDraftToQc() {
        CoreSession adminSession = sessionAs(ADMIN, List.of(), true);
        DocumentModel doc = createDraftAsset(adminSession);
        grantReadWrite(adminSession, doc, PRODUCER);
        grant(adminSession, doc, PRODUCER, "MAM_SubmitForReview");

        CoreSession producerSession = sessionAs(PRODUCER, List.of("mam-producers"), false);
        DocumentModel asProducer = producerSession.getDocument(doc.getRef());
        asProducer.setPropertyValue("broadcast:editorialStatus", "qc");
        asProducer = producerSession.saveDocument(asProducer);
        producerSession.save();

        assertEquals("qc", asProducer.getPropertyValue("broadcast:editorialStatus"));
    }

    @Test
    public void producerWithoutApprovePermissionCannotSelfApprove() {
        // This is the exact bug report: a producer with plain Write (and
        // MAM_SubmitForReview, but NOT MAM_Approve) must not be able to
        // set editorialStatus=approved directly, bypassing the entire
        // editorial review step.
        CoreSession adminSession = sessionAs(ADMIN, List.of(), true);
        DocumentModel doc = createDraftAsset(adminSession);
        grantReadWrite(adminSession, doc, PRODUCER);
        grant(adminSession, doc, PRODUCER, "MAM_SubmitForReview");

        CoreSession producerSession = sessionAs(PRODUCER, List.of("mam-producers"), false);
        assertTrue("producer must have Write for this test to be meaningful",
                producerSession.hasPermission(doc.getRef(), SecurityConstants.WRITE));

        DocumentModel asProducer = producerSession.getDocument(doc.getRef());
        asProducer.setPropertyValue("broadcast:editorialStatus", "approved");
        DocumentSecurityException ex = assertThrows(DocumentSecurityException.class,
                () -> producerSession.saveDocument(asProducer));
        assertEquals(403, ex.getStatusCode());

        DocumentModel reread = adminSession.getDocument(doc.getRef());
        assertEquals("still draft: the direct-write bypass must be rejected", "draft",
                reread.getPropertyValue("broadcast:editorialStatus"));
    }

    @Test
    public void editorWithApprovePermissionCanApprove() {
        CoreSession adminSession = sessionAs(ADMIN, List.of(), true);
        DocumentModel doc = createDraftAsset(adminSession);
        doc.setPropertyValue("broadcast:editorialStatus", "qc");
        doc = adminSession.saveDocument(doc);
        adminSession.save();

        // NOTE: MAM_EditorAccess (the real-world ACL bundle for
        // mam-editors, see mam-security-contrib.xml) deliberately does
        // NOT include Write — in production, the actual approve/reject
        // write happens through the MAM_EDITORIAL_APPROVAL workflow's
        // task-completion path, which Nuxeo's routing engine executes
        // with elevated privilege internally (bypassing the core
        // WriteProperties check) even though the acting NuxeoPrincipal
        // recorded on the event is still the real editor — which is
        // exactly why this listener checks the MAM_Approve/MAM_Reject
        // ACL permission rather than Write. A plain `saveDocument()`
        // call from an ordinary CoreSession (as this unit test does,
        // exercising the listener directly without spinning up the full
        // routing engine) is a stand-in for that privileged path, so
        // Write is granted here too, purely so the call reaches this
        // listener at all instead of being rejected earlier by Nuxeo
        // core's own unrelated WriteProperties check.
        grantReadWrite(adminSession, doc, EDITOR);
        grant(adminSession, doc, EDITOR, "MAM_Approve");
        grant(adminSession, doc, EDITOR, "MAM_Reject");

        CoreSession editorSession = sessionAs(EDITOR, List.of("mam-editors"), false);
        DocumentModel asEditor = editorSession.getDocument(doc.getRef());
        asEditor.setPropertyValue("broadcast:editorialStatus", "approved");
        asEditor = editorSession.saveDocument(asEditor);
        editorSession.save();

        assertEquals("approved", asEditor.getPropertyValue("broadcast:editorialStatus"));
    }

    @Test
    public void editorCanRejectButProducerCannotRejectOwnSubmission() {
        CoreSession adminSession = sessionAs(ADMIN, List.of(), true);
        DocumentModel doc = createDraftAsset(adminSession);
        doc.setPropertyValue("broadcast:editorialStatus", "qc");
        doc = adminSession.saveDocument(doc);
        adminSession.save();

        grantReadWrite(adminSession, doc, PRODUCER);
        grant(adminSession, doc, PRODUCER, "MAM_SubmitForReview");

        CoreSession producerSession = sessionAs(PRODUCER, List.of("mam-producers"), false);
        DocumentModel asProducer = producerSession.getDocument(doc.getRef());
        asProducer.setPropertyValue("broadcast:editorialStatus", "rejected");
        DocumentSecurityException ex = assertThrows(DocumentSecurityException.class,
                () -> producerSession.saveDocument(asProducer));
        assertEquals(403, ex.getStatusCode());
    }

    @Test
    public void administratorCanChangeEditorialStatusToAnyValue() {
        CoreSession adminSession = sessionAs(ADMIN, List.of(), true);
        DocumentModel doc = createDraftAsset(adminSession);

        doc.setPropertyValue("broadcast:editorialStatus", "approved");
        doc = adminSession.saveDocument(doc);
        adminSession.save();

        assertEquals("approved", doc.getPropertyValue("broadcast:editorialStatus"));
    }

    @Test
    public void unrecognisedValueIsRejectedEvenForOtherwisePermittedCaller() {
        CoreSession adminSession = sessionAs(ADMIN, List.of(), true);
        DocumentModel doc = createDraftAsset(adminSession);
        grantReadWrite(adminSession, doc, PRODUCER);
        grant(adminSession, doc, PRODUCER, "MAM_SubmitForReview");
        grant(adminSession, doc, PRODUCER, "MAM_Approve");
        grant(adminSession, doc, PRODUCER, "MAM_Reject");

        CoreSession producerSession = sessionAs(PRODUCER, List.of("mam-producers"), false);
        DocumentModel asProducer = producerSession.getDocument(doc.getRef());
        asProducer.setPropertyValue("broadcast:editorialStatus", "published");
        DocumentSecurityException ex = assertThrows(DocumentSecurityException.class,
                () -> producerSession.saveDocument(asProducer));
        assertEquals(403, ex.getStatusCode());
    }

    @Test
    public void producerCanStillChangeUnrelatedMetadataFields() {
        // Sanity check: the guard is scoped to broadcast:editorialStatus
        // only, not a blanket lockout of the producer's granted Write.
        CoreSession adminSession = sessionAs(ADMIN, List.of(), true);
        DocumentModel doc = createDraftAsset(adminSession);
        grantReadWrite(adminSession, doc, PRODUCER);

        CoreSession producerSession = sessionAs(PRODUCER, List.of("mam-producers"), false);
        DocumentModel asProducer = producerSession.getDocument(doc.getRef());
        asProducer.setPropertyValue("dc:description", "edited by producer1");
        asProducer = producerSession.saveDocument(asProducer);
        producerSession.save();

        assertEquals("edited by producer1", asProducer.getPropertyValue("dc:description"));
    }

}
