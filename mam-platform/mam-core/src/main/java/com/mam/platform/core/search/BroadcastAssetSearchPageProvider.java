/*
 * (C) Copyright 2026 MAM Platform. All rights reserved.
 * Proprietary and confidential.
 */
package com.mam.platform.core.search;

import org.apache.commons.lang3.StringUtils;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.ecm.core.api.CoreSession;
import org.nuxeo.ecm.core.query.sql.NXQL;
import org.nuxeo.ecm.platform.query.core.FieldDescriptor;
import org.nuxeo.ecm.platform.query.nxql.NXQLQueryBuilder;
import org.nuxeo.ecm.platform.query.nxql.CoreQueryDocumentPageProvider;

/**
 * Backs the {@code MAM_BROADCAST_ASSET_SEARCH} named page provider.
 *
 * <p>
 * The {@code q} free-text search box needs to match across several
 * {@code BroadcastAsset} metadata fields ({@code dc:title},
 * {@code broadcast:slug}, {@code broadcast:programme},
 * {@code broadcast:bureau}, {@code broadcast:storyType}) instead of just the
 * title. Nuxeo's declarative
 * {@code whereClause}/{@code <predicate>} mechanism cannot express this:
 * {@link NXQLQueryBuilder#getQueryElement} always joins every predicate with
 * {@code AND} ("only a one level conjunctive WHERE clause" per its own
 * comment), so a single {@code q} parameter can only ever be bound to one
 * column that way, never OR'd across several. This class is the small,
 * targeted escape hatch: it lets the declarative {@code whereClause} in
 * {@code mam-core-contrib.xml} keep handling every discrete filter
 * ({@code storyType}/{@code bureau}/{@code editorialStatus}/
 * {@code archiveState}) and the fixed trashed/version/proxy part exactly as
 * before, and only takes over to splice in the OR'd free-text clause once
 * the rest of the NXQL query has already been built by the stock
 * {@code CoreQueryDocumentPageProvider}/{@code SearchServicePageProvider}
 * logic.
 * </p>
 *
 * <p>
 * Still extends {@link SearchServicePageProvider} (rather than the plain
 * {@code CoreQueryDocumentPageProvider}) so query execution and the
 * {@code aggregates} block in the contrib keep going through Nuxeo's
 * {@code SearchService} unchanged -- on the PostgreSQL + Elasticsearch
 * integration stack that resolves to a real search index, and on the
 * disposable H2 smoke stack it falls back to the repository/VCS search
 * client, which executes plain NXQL (including {@code OR} and {@code LIKE})
 * with no fulltext dependency, matching the existing constraint that this
 * provider must keep working without Elasticsearch configured.
 * </p>
 *
 * <p>
 * {@code q} itself is read the exact same way the previous declarative
 * {@code <field name="q" />} predicate did: {@link NXQLQueryBuilder}
 * resolves a field with no {@code schema}/{@code xpath} by first trying it
 * as a plain document property, then falling back to the search document
 * model's {@code namedParameters} context data (see
 * {@code NXQLQueryBuilder#getRawValue}) -- which is exactly how the REST
 * search endpoint surfaces the {@code ?q=} request parameter. Reusing that
 * helper keeps this class decoupled from any assumption about how {@code q}
 * physically arrives on the search document model.
 * </p>
 */
public class BroadcastAssetSearchPageProvider extends CoreQueryDocumentPageProvider {

    private static final long serialVersionUID = 1L;

    private static final Logger log = LogManager.getLogger(BroadcastAssetSearchPageProvider.class);

    /** Name of the free-text request parameter, e.g. {@code ?q=wildebeest}. */
    public static final String Q_PARAMETER = "q";

    /**
     * {@code BroadcastAsset} properties the free-text {@code q} parameter is
     * matched against, in addition to {@code dc:title}.
     */
    protected static final String[] FREETEXT_XPATHS = { "dc:title", "broadcast:slug", "broadcast:programme",
            "broadcast:bureau", "broadcast:storyType" };

    @Override
    protected void buildQuery(CoreSession coreSession) {
        // Builds the standard AND-joined query (discrete filters + fixed
        // trashed/version/proxy part) exactly as declared in the
        // whereClause; the `q` predicate itself is deliberately no longer
        // part of that whereClause (see mam-core-contrib.xml), so it plays
        // no part in this call.
        super.buildQuery(coreSession);

        String freetext = NXQLQueryBuilder.getPlainStringValue(getSearchDocumentModel(),
                new FieldDescriptor(Q_PARAMETER));
        if (StringUtils.isNotBlank(freetext)) {
            query = appendFreetextClause(query, freetext);
        }
        log.warn("MAM_DEBUG final query = [{}]", query);
    }

    /**
     * Appends an {@code AND (col1 ILIKE 'v' OR col2 ILIKE 'v' OR ...)} clause
     * to {@code nxqlQuery}, inserted before any trailing {@code ORDER BY} so
     * the sort clause remains last.
     */
    protected String appendFreetextClause(String nxqlQuery, String freetextValue) {
        String literal = NXQL.escapeString(freetextValue);
        StringBuilder orClause = new StringBuilder("(");
        for (int i = 0; i < FREETEXT_XPATHS.length; i++) {
            if (i > 0) {
                orClause.append(" OR ");
            }
            orClause.append(FREETEXT_XPATHS[i]).append(" ILIKE ").append(literal);
        }
        orClause.append(')');

        int orderByIndex = nxqlQuery.indexOf(" ORDER BY ");
        if (orderByIndex < 0) {
            return nxqlQuery + " AND " + orClause;
        }
        return nxqlQuery.substring(0, orderByIndex) + " AND " + orClause + nxqlQuery.substring(orderByIndex);
    }

}
