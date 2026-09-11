/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.security.listener;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
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
import org.nuxeo.ecm.core.test.CoreFeature;
import org.nuxeo.ecm.core.test.annotations.Granularity;
import org.nuxeo.ecm.core.test.annotations.RepositoryConfig;
import org.nuxeo.runtime.test.runner.Deploy;
import org.nuxeo.runtime.test.runner.Features;
import org.nuxeo.runtime.test.runner.FeaturesRunner;

/**
 * Runtime test for the server-enforced {@code broadcast:archiveState}
 * guard. Exercises the listener directly through {@code CoreSession}, which
 * is exactly the layer every REST/automation path funnels through
 * ({@code JSONDocumentObject#doPut} -&gt; {@code session.saveDocument}), so
 * this proves enforcement independent of any particular HTTP endpoint.
 */
@RunWith(FeaturesRunner.class)
@Features(CoreFeature.class)
@Deploy("org.nuxeo.ecm.platform.query.api")
@Deploy("com.mam.platform.core")
@Deploy("com.mam.platform.security")
@RepositoryConfig(cleanup = Granularity.METHOD)
public class ArchiveStateGuardListenerTest {

    protected static final String ARCHIVIST = "archivist1";

    protected static final String EDITOR = "editor1";

    protected static final String ADMIN = "Administrator";

    @Inject
    protected CoreFeature coreFeature;

    protected DocumentModel createHotAsset(CoreSession session) {
        DocumentModel doc = session.createDocumentModel("/", "asset", "BroadcastAsset");
        doc.setPropertyValue("dc:title", "Guard test asset");
        doc.setPropertyValue("broadcast:archiveState", "hot");
        doc = session.createDocument(doc);
        session.save();
        return doc;
    }

    protected CoreSession sessionAs(String username, List<String> groups, boolean administrator) {
        return coreFeature.getCoreSession(new UserPrincipal(username, groups, false, administrator));
    }

    protected void grantReadWrite(CoreSession adminSession, DocumentModel doc, String username) {
        org.nuxeo.ecm.core.api.security.ACP acp = adminSession.getACP(doc.getRef());
        acp.addACE(org.nuxeo.ecm.core.api.security.ACL.LOCAL_ACL,
                new org.nuxeo.ecm.core.api.security.ACE(username,
                        org.nuxeo.ecm.core.api.security.SecurityConstants.READ_WRITE, true));
        adminSession.setACP(doc.getRef(), acp, true);
        adminSession.save();
    }

    @Test
    public void archivistCanArchiveAndRestore() {
        CoreSession adminSession = sessionAs(ADMIN, List.of(), true);
        DocumentModel doc = createHotAsset(adminSession);
        grantReadWrite(adminSession, doc, ARCHIVIST);

        CoreSession archivistSession = sessionAs(ARCHIVIST, List.of("mam-archivists"), false);
        DocumentModel asArchivist = archivistSession.getDocument(doc.getRef());

        // Archive: hot -> cold.
        asArchivist.setPropertyValue("broadcast:archiveState", "cold");
        asArchivist = archivistSession.saveDocument(asArchivist);
        archivistSession.save();
        assertEquals("cold", asArchivist.getPropertyValue("broadcast:archiveState"));
        assertEquals(ARCHIVIST, asArchivist.getPropertyValue("broadcast:archivedBy"));
        assertNotNull("archiveDate must be stamped on hot -> cold", asArchivist.getPropertyValue("broadcast:archiveDate"));
        assertNull("restoredBy must not be set yet", asArchivist.getPropertyValue("broadcast:restoredBy"));

        // Restore: cold -> hot.
        asArchivist.setPropertyValue("broadcast:archiveState", "hot");
        asArchivist = archivistSession.saveDocument(asArchivist);
        archivistSession.save();
        assertEquals("hot", asArchivist.getPropertyValue("broadcast:archiveState"));
        assertEquals(ARCHIVIST, asArchivist.getPropertyValue("broadcast:restoredBy"));
        assertNotNull("restoreDate must be stamped on cold -> hot", asArchivist.getPropertyValue("broadcast:restoreDate"));
        // The prior archive stamp is preserved as history, not cleared.
        assertEquals(ARCHIVIST, asArchivist.getPropertyValue("broadcast:archivedBy"));
    }

    @Test
    public void editorWithWriteCannotChangeArchiveState() {
        CoreSession adminSession = sessionAs(ADMIN, List.of(), true);
        DocumentModel doc = createHotAsset(adminSession);

        // Grant standard Read+Write to the editor on this document, proving
        // the guard is independent of (and stronger than) standard ACLs.
        grantReadWrite(adminSession, doc, EDITOR);

        CoreSession editorSession = sessionAs(EDITOR, List.of("mam-editors"), false);
        DocumentModel asEditor = editorSession.getDocument(doc.getRef());
        assertTrue("editor must have Write for this test to be meaningful",
                editorSession.hasPermission(doc.getRef(), org.nuxeo.ecm.core.api.security.SecurityConstants.WRITE));

        asEditor.setPropertyValue("broadcast:archiveState", "cold");
        DocumentSecurityException ex = assertThrows(DocumentSecurityException.class,
                () -> editorSession.saveDocument(asEditor));
        assertEquals(403, ex.getStatusCode());

        // Confirm the property was not actually changed server-side.
        DocumentModel reread = adminSession.getDocument(doc.getRef());
        assertEquals("hot", reread.getPropertyValue("broadcast:archiveState"));
        assertNull("audit fields must not be stamped on a denied change", reread.getPropertyValue("broadcast:archivedBy"));
        assertNull("audit fields must not be stamped on a denied change", reread.getPropertyValue("broadcast:archiveDate"));
    }

    @Test
    public void administratorCanChangeArchiveState() {
        CoreSession adminSession = sessionAs(ADMIN, List.of(), true);
        DocumentModel doc = createHotAsset(adminSession);

        doc.setPropertyValue("broadcast:archiveState", "cold");
        doc = adminSession.saveDocument(doc);
        adminSession.save();
        assertEquals("cold", doc.getPropertyValue("broadcast:archiveState"));
        assertEquals(ADMIN, doc.getPropertyValue("broadcast:archivedBy"));
        assertNotNull("archiveDate must be stamped for administrator too", doc.getPropertyValue("broadcast:archiveDate"));
    }

    @Test
    public void editorCanStillChangeUnrelatedMetadataFields() {
        // Sanity check: the guard is scoped to broadcast:archiveState only,
        // not a blanket lockout of the editor's granted Write permission.
        CoreSession adminSession = sessionAs(ADMIN, List.of(), true);
        DocumentModel doc = createHotAsset(adminSession);
        grantReadWrite(adminSession, doc, EDITOR);

        CoreSession editorSession = sessionAs(EDITOR, List.of("mam-editors"), false);
        DocumentModel asEditor = editorSession.getDocument(doc.getRef());
        asEditor.setPropertyValue("dc:description", "edited by editor1");
        asEditor = editorSession.saveDocument(asEditor);
        editorSession.save();
        assertEquals("edited by editor1", asEditor.getPropertyValue("dc:description"));
    }

}
