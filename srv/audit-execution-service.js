// srv/audit-execution-service.js
const cds = require('@sap/cds');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const https = require('https');
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const { getAllDestinationsFromDestinationService } = require('@sap-cloud-sdk/connectivity');
const pino = require('pino');

// Configure logger
const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: null
    // transport: {
    //     target: 'pino-pretty',
    //     options: {
    //         colorize: true,
    //         translateTime: 'SYS:standard',
    //         ignore: 'pid,hostname'
    //     }
    // }

});

function getJwt(req) {
    // For hybrid/local testing, you might need to create a mock token
    // In cloud environment, it comes from the request
    const authHeader = req.headers?.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7);
    }

    // For hybrid mode without actual user, you can use a dummy token
    // This token is just for service-to-service communication
    if (process.env.NODE_ENV === 'hybrid' || process.env.VCAP_APPLICATION) {
        // Return a dummy token - the destination service will use the binding credentials
        return 'dummy-token-for-hybrid';
    }

    return null;
}

// Batch configuration
const BATCH_CONFIG = {
    USER_BATCH_SIZE: 1000,
    GROUP_BATCH_SIZE: 20,
    MEMBER_BATCH_SIZE: 500,
    API_PARALLEL_LIMIT: 5,
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 1000
};

module.exports = cds.service.impl(async function () {

    this.activeRuns = new Map();

    // ============================
    // ===== ALL HELPER FUNCTIONS =====
    // ============================

    // Helper: Get SF Destination Config
    async function _getSFDestination(instanceName, auditLogger, req) {
        try {
            // Get JWT for authentication
            const jwt = req ? getJwt(req) : null;

            // Use getDestination with JWT
            const destination = await getDestination({
                destinationName: instanceName,
                jwt: jwt
            });

            if (!destination) {
                throw new Error(`Destination '${instanceName}' not found`);
            }

            // Check sfaudit property from originalProperties
            const hasSFAudit = destination.originalProperties?.sfaudit === 'true' ||
                destination.originalProperties?.sfaudit === true;

            if (!hasSFAudit) {
                throw new Error(`Destination '${instanceName}' is not configured for SF Audit (missing sfaudit=true)`);
            }

            auditLogger.info({ instance: instanceName, url: destination.url }, 'Destination configured');

            return {
                baseURL: destination.url,
                auth: {
                    username: destination.username,
                    password: destination.password
                },
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                httpsAgent: new https.Agent({ rejectUnauthorized: false }),
                timeout: 30000,
                instanceName: instanceName
            };

        } catch (error) {
            auditLogger.error({ error: error.message, instance: instanceName }, 'Failed to get SF destination');
            throw error;
        }
    }

    // Fetch all users from SuccessFactors
    async function _fetchAllUsers(sfConfig, auditLogger) {
        const users = [];
        let skip = 0;
        const top = 1000;
        let hasMore = true;

        auditLogger.info('Fetching all users from SuccessFactors');

        while (hasMore) {
            try {
                const url = `${sfConfig.baseURL}/User?$format=json&$top=${top}&$skip=${skip}`;

                const response = await axios.get(url, {
                    auth: sfConfig.auth,
                    headers: sfConfig.headers,
                    httpsAgent: sfConfig.httpsAgent
                });

                const results = response.data?.d?.results || [];
                users.push(...results);

                hasMore = results.length === top;
                skip += top;

                auditLogger.debug({ fetched: results.length, total: users.length }, 'Users batch fetched');

            } catch (error) {
                auditLogger.error({ error: error.message, skip }, 'Failed to fetch users batch');
                throw error;
            }
        }

        auditLogger.info({ totalUsers: users.length }, 'All users fetched');
        return users;
    }

    // Format users with instance
    function _formatUsers(rawUsers, instance) {
        return rawUsers.map(user => ({
            userId: user.userId,
            instance: instance,
            userName: user.userName || user.username || '',
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            status: user.status === 'T' ? 'inactive' : 'active',
            email: user.email || '',
            hireDate: user.hireDate ? new Date(user.hireDate) : null,
            terminationDate: user.companyExitDate ? new Date(user.companyExitDate) : null,
            lastModifiedDateTime: user.lastModifiedDateTime ? new Date(parseInt(user.lastModifiedDateTime.replace(/\D/g, ''))) : new Date(),
            jobTitle: user.jobTitle || '',
            department: user.department || '',
            lastSyncAt: new Date(),
            isActive: user.status !== 'T'
        }));
    }

    // Upsert users with instance
    async function _upsertUsers(tx, users, instance, auditLogger) {
        let inserted = 0;
        let updated = 0;

        for (let i = 0; i < users.length; i += BATCH_CONFIG.USER_BATCH_SIZE) {
            const batch = users.slice(i, i + BATCH_CONFIG.USER_BATCH_SIZE);

            for (const user of batch) {
                try {
                    const existing = await tx.run(
                        SELECT.one.from('Users').where({ userId: user.userId, instance: instance })
                    );

                    if (existing) {
                        await tx.run(
                            UPDATE('Users')
                                .set({
                                    userName: user.userName,
                                    firstName: user.firstName,
                                    lastName: user.lastName,
                                    status: user.status,
                                    email: user.email,
                                    hireDate: user.hireDate,
                                    terminationDate: user.terminationDate,
                                    lastModifiedDateTime: user.lastModifiedDateTime,
                                    jobTitle: user.jobTitle,
                                    department: user.department,
                                    lastSyncAt: new Date(),
                                    isActive: user.isActive
                                })
                                .where({ userId: user.userId, instance: instance })
                        );
                        updated++;
                    } else {
                        await tx.run(INSERT.into('Users').entries(user));
                        inserted++;
                    }
                } catch (error) {
                    auditLogger.error({ userId: user.userId, error: error.message }, 'Failed to upsert user');
                }
            }
        }

        return { inserted, updated };
    }

    // Fetch only users modified after a specific timestamp                             //Added
    async function _fetchUsersModifiedAfter(sfConfig, lastSyncTimestamp, auditLogger) {
        const users = [];
        let skip = 0;
        const top = 1000;
        let hasMore = true;

        const filterDate = lastSyncTimestamp.toISOString();

        auditLogger.info({ filterDate, top }, 'Fetching users modified after timestamp');

        while (hasMore) {
            try {
                const url = `${sfConfig.baseURL}/User?$format=json&$top=${top}&$skip=${skip}&$filter=lastModifiedDateTime gt datetime'${filterDate}'`;

                const response = await axios.get(url, {
                    auth: sfConfig.auth,
                    headers: sfConfig.headers,
                    httpsAgent: sfConfig.httpsAgent,
                    timeout: sfConfig.timeout
                });

                const results = response.data?.d?.results || [];
                users.push(...results);

                hasMore = results.length === top;
                skip += top;

                auditLogger.debug({
                    fetched: results.length,
                    total: users.length,
                    skip: skip
                }, 'Users batch fetched');

            } catch (error) {
                auditLogger.error({ error: error.message, skip, filterDate }, 'Failed to fetch users batch');

                // If filter fails (e.g., field doesn't exist), fallback to full fetch
                if (skip === 0 && error.response?.status === 400) {
                    auditLogger.warn('Filter failed, falling back to full fetch');
                    return _fetchAllUsers(sfConfig, auditLogger);
                }
                throw error;
            }
        }

        auditLogger.info({ totalUsers: users.length, filterDate }, 'Modified users fetched');
        return users;
    }

    // Fetch groups with pagination
    async function _fetchGroupsWithPagination(sfConfig, isStatic, auditLogger) {
        const groups = [];
        let skip = 0;
        const top = 100;
        let hasMore = true;

        while (hasMore) {
            try {
                const url = `${sfConfig.baseURL}/DynamicGroup?$format=json&$top=${top}&$skip=${skip}&$filter=staticGroup eq ${isStatic}`;

                const response = await axios.get(url, {
                    auth: sfConfig.auth,
                    headers: sfConfig.headers,
                    httpsAgent: sfConfig.httpsAgent,
                    timeout: sfConfig.timeout
                });

                const results = response.data?.d?.results || [];
                groups.push(...results);

                hasMore = results.length === top;
                skip += top;

            } catch (error) {
                auditLogger.error({ error: error.message, isStatic, skip }, 'Failed to fetch groups batch');
                throw error;
            }
        }

        return groups;
    }

    // Save groups
    async function _saveGroups(tx, auditRunID, groups, groupType, auditLogger) {
        if (!groups.length) return;

        const entries = groups.map(g => ({
            ID: uuidv4(),
            auditRunID_ID: auditRunID,
            groupID: String(g.groupID || g.id),
            groupName: g.groupName || g.name,
            groupType: groupType,
            groupTypeInternal: g.groupTypeInternal || 'permission',
            activeMembershipCount: g.activeMembershipCount || 0,
            totalMemberCount: g.totalMemberCount || 0,
            createdBy: g.createdBy || '',
            lastModifiedDate: g.lastModifiedDate ? new Date(g.lastModifiedDate) : null
        }));

        const batchSize = 500;
        for (let i = 0; i < entries.length; i += batchSize) {
            const batch = entries.slice(i, i + batchSize);
            await tx.run(INSERT.into('Groups').entries(batch));
        }

        auditLogger.info({ groupType, count: entries.length }, 'Groups saved');
    }

    // Fetch group members
    async function _fetchGroupMembers(groupId, sfConfig, auditLogger) {
        const url = `${sfConfig.baseURL}/getUsersByDynamicGroup?groupId=${groupId}L&$format=json`;

        try {
            const response = await axios.get(url, {
                auth: sfConfig.auth,
                headers: sfConfig.headers,
                httpsAgent: sfConfig.httpsAgent,
                timeout: sfConfig.timeout
            });

            auditLogger.info({ groupId }, 'Successfully fetched group members');
            return response.data.d || [];

        } catch (error) {
            auditLogger.error({ groupId, error: error.message }, 'Failed to fetch group members');
            return [];
        }
    }

    // Save memberships
    async function _saveMemberships(tx, auditRunID, memberships, auditLogger) {
        if (!memberships.length) return 0;

        auditLogger.info({ count: memberships.length }, 'Saving memberships');

        const userIds = [...new Set(memberships.map(m => m.userId))];
        const existingUsers = await tx.run(
            SELECT.from('Users').where({ userId: { in: userIds } })
        );

        const existingUserIds = new Set(existingUsers.map(u => u.userId));
        const validMemberships = memberships.filter(m => existingUserIds.has(m.userId));

        if (validMemberships.length < memberships.length) {
            auditLogger.warn({
                total: memberships.length,
                valid: validMemberships.length,
                invalid: memberships.length - validMemberships.length
            }, 'Some memberships skipped due to missing users');
        }

        const entries = [];
        for (const membership of validMemberships) {
            entries.push({
                ID: uuidv4(),
                auditRunID_ID: auditRunID,
                groupID: membership.groupID,
                groupName: membership.groupName,
                userId: membership.userId,
                userName: membership.userName
            });
        }

        await tx.run(DELETE.from('GroupMembers').where({ auditRunID_ID: auditRunID }));

        for (let i = 0; i < entries.length; i += BATCH_CONFIG.MEMBER_BATCH_SIZE) {
            const batch = entries.slice(i, i + BATCH_CONFIG.MEMBER_BATCH_SIZE);
            await tx.run(INSERT.into('GroupMembers').entries(batch));
            auditLogger.debug({ batch: i / BATCH_CONFIG.MEMBER_BATCH_SIZE + 1, size: batch.length }, 'Memberships batch saved');
        }

        auditLogger.info({ count: entries.length }, 'Memberships saved');
        return entries.length;
    }

    // Fetch and save members
    async function _fetchAndSaveMembers(tx, auditRunID, groups, sfConfig, config, auditLogger) {
        const memberships = new Set();
        let processedGroups = 0;

        auditLogger.info({ groupCount: groups.length }, 'Starting member extraction');

        const groupChunks = [];
        for (let i = 0; i < groups.length; i += BATCH_CONFIG.API_PARALLEL_LIMIT) {
            groupChunks.push(groups.slice(i, i + BATCH_CONFIG.API_PARALLEL_LIMIT));
        }

        for (const chunk of groupChunks) {
            const chunkPromises = chunk.map(async (group) => {
                try {
                    const members = await _fetchGroupMembers(group.groupID, sfConfig, auditLogger);
                    for (const member of members) {
                        const membershipKey = `${group.groupID}-${member.userId}`;
                        memberships.add({
                            key: membershipKey,
                            groupID: group.groupID,
                            groupName: group.groupName,
                            userId: member.userId,
                            userName: member.userName || member.username
                        });
                    }
                    processedGroups++;
                    if (processedGroups % 10 === 0) {
                        auditLogger.info({ processed: processedGroups, total: groups.length }, 'Membership progress');
                    }
                } catch (error) {
                    auditLogger.error({ groupID: group.groupID, error: error.message }, 'Failed to fetch group members');
                }
            });
            await Promise.all(chunkPromises);
        }

        auditLogger.info({ memberships: memberships.size }, 'Membership data collected');
        const membershipsSaved = await _saveMemberships(tx, auditRunID, Array.from(memberships), auditLogger);

        return { membershipsProcessed: membershipsSaved };
    }

    // Update group statistics
    async function _updateGroupStatistics(tx, auditRunID, auditLogger) {
        await tx.run(`
            UPDATE sap_sf_audit_Groups 
            SET activeMembershipCount = (
                SELECT COUNT(*) 
                FROM sap_sf_audit_GroupMembers 
                WHERE sap_sf_audit_GroupMembers.GROUP_ID = sap_sf_audit_Groups.GROUPID 
                AND sap_sf_audit_GroupMembers.auditRunID_ID = ?
            )
            WHERE auditRunID_ID = ?
        `, [auditRunID, auditRunID]);
    }

    // Fetch roles with pagination
    async function _fetchRolesWithPagination(sfConfig, auditLogger) {
        const roles = [];
        let skip = 0;
        const top = 100;
        let hasMore = true;

        while (hasMore) {
            try {
                const url = `${sfConfig.baseURL}/RBPRole?$format=json&$top=${top}&$skip=${skip}`;

                const response = await axios.get(url, {
                    auth: sfConfig.auth,
                    headers: sfConfig.headers,
                    httpsAgent: sfConfig.httpsAgent,
                    timeout: sfConfig.timeout
                });

                const results = response.data?.d?.results || [];
                roles.push(...results);

                hasMore = results.length === top;
                skip += top;

            } catch (error) {
                auditLogger.error({ error: error.message, skip }, 'Failed to fetch roles batch');
                throw error;
            }
        }

        return roles;
    }

    // Save roles
    async function _saveRoles(tx, auditRunID, roles, auditLogger) {
        if (!roles.length) return;

        const entries = roles.map(r => ({
            ID: uuidv4(),
            auditRunID_ID: auditRunID,
            roleId: r.roleId || r.id,
            roleName: r.roleName || r.name,
            roleDesc: r.roleDesc || r.description || '',
            roleType: r.roleType || 'standard',
            userType: r.userType || 'user',
            lastModifiedBy: r.lastModifiedBy || '',
            lastModifiedDate: r.lastModifiedDate ? new Date(r.lastModifiedDate) : new Date()
        }));

        const batchSize = 500;
        for (let i = 0; i < entries.length; i += batchSize) {
            const batch = entries.slice(i, i + batchSize);
            await tx.run(INSERT.into('Roles').entries(batch));
        }

        auditLogger.info({ count: entries.length }, 'Roles saved');
    }

    // Generate analytics
    async function _generateAnalytics(tx, auditRunID, auditLogger) {
        try {
            await tx.run(`
                INSERT INTO sap_sf_audit_UserGroupCountDistribution 
                ("ID", "AUDITRUNID_ID", "BUCKET", "USERCOUNT", "ISHIGHESTBUCKET")
                SELECT 
                    SYSUUID AS "ID",
                    ? AS "AUDITRUNID_ID",
                    CASE 
                        WHEN group_count = 1 THEN '1 group'
                        WHEN group_count = 2 THEN '2 groups'
                        WHEN group_count <= 4 THEN '3–4 groups'
                        WHEN group_count <= 7 THEN '5–7 groups'
                        ELSE '8+ groups'
                    END AS "BUCKET",
                    COUNT(*) AS "USERCOUNT",
                    FALSE AS "ISHIGHESTBUCKET"
                FROM (
                    SELECT "USERID", COUNT(*) as group_count
                    FROM sap_sf_audit_GroupMembers
                    WHERE "AUDITRUNID_ID" = ?
                    GROUP BY "USERID"
                )
                GROUP BY 
                    CASE 
                        WHEN group_count = 1 THEN '1 group'
                        WHEN group_count = 2 THEN '2 groups'
                        WHEN group_count <= 4 THEN '3–4 groups'
                        WHEN group_count <= 7 THEN '5–7 groups'
                        ELSE '8+ groups'
                    END
            `, [auditRunID, auditRunID]);

            auditLogger.info('Analytics generated');
        } catch (error) {
            console.log("error", error);
            auditLogger.error({ error: error.message }, 'Failed to generate analytics');
            throw error;
        }
    }

    // Populate role targets and unused roles
    async function _populateRoleTargetsAndUnusedRoles(tx, auditRunID, sfConfig, auditLogger) {
        try {
            auditLogger.info('Populating role target populations');

            await tx.run(DELETE.from('RoleTargetPopulations').where({ auditRunID_ID: auditRunID }));
            await tx.run(DELETE.from('UnusedRoles').where({ auditRunID_ID: auditRunID }));

            const groups = await tx.run(
                SELECT.from('Groups').where({ auditRunID_ID: auditRunID })
            );

            if (!groups.length) {
                auditLogger.warn('No groups found, skipping role targets');
                return;
            }

            for (const group of groups) {
                try {
                    const roleTargetEndpoints = [
                        `${sfConfig.baseURL}/DynamicGroup('${group.groupID}')/roleTargets?$format=json`,
                        `${sfConfig.baseURL}/RBPRule?$filter=groupId eq '${group.groupID}'&$format=json`,
                        `${sfConfig.baseURL}/getRoleTargetsByGroup?groupId=${group.groupID}&$format=json`
                    ];

                    for (const url of roleTargetEndpoints) {
                        try {
                            const response = await axios.get(url, {
                                auth: sfConfig.auth,
                                headers: sfConfig.headers,
                                httpsAgent: sfConfig.httpsAgent,
                                timeout: 10000
                            });

                            const targets = response.data?.d?.results || [];
                            if (targets.length > 0) {
                                auditLogger.debug({ groupId: group.groupID, count: targets.length }, 'Found role targets');

                                for (const target of targets) {
                                    await tx.run(`
                                        INSERT INTO sap_sf_audit_RoleTargetPopulations (
                                            ID, auditRunID_ID, roleId, roleName, groupId, groupName,
                                            source, ruleId, ruleMyFilter
                                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                                    `, [
                                        uuidv4(), auditRunID,
                                        target.roleId || target.id,
                                        target.roleName || target.name,
                                        group.groupID, group.groupName,
                                        'api_fetch',
                                        target.ruleId || '',
                                        target.ruleMyFilter || ''
                                    ]);
                                }
                                break;
                            }
                        } catch (e) {
                            auditLogger.debug({ groupId: group.groupID, url }, 'Endpoint failed');
                        }
                    }
                } catch (error) {
                    auditLogger.debug({ groupId: group.groupID }, 'No role targets found for group');
                }
            }

            const roles = await tx.run(
                SELECT.from('Roles').where({ auditRunID_ID: auditRunID })
            );

            if (roles.length) {
                const rolesWithTargets = await tx.run(
                    SELECT.from('RoleTargetPopulations').where({ auditRunID_ID: auditRunID })
                        .columns('distinct roleId')
                );

                const usedRoleIds = new Set(rolesWithTargets.map(r => r.roleId));

                for (const role of roles) {
                    if (!usedRoleIds.has(role.roleId)) {
                        await tx.run(`
                            INSERT INTO sap_sf_audit_UnusedRoles (
                                ID, auditRunID_ID, roleId, roleName, roleType, recommendation
                            ) VALUES (?, ?, ?, ?, ?, ?)
                        `, [
                            uuidv4(), auditRunID, role.roleId, role.roleName,
                            role.roleType || 'standard', 'Review / Decommission'
                        ]);
                    }
                }
            }

            auditLogger.info('Role targets and unused roles populated');
        } catch (error) {
            auditLogger.error({ error: error.message }, 'Failed to populate role targets');
        }
    }

    //Added 2-02-2026 It creates the link between USERS and ROLES by joining

    async function _populateUserRoleMappings(tx, auditRunID, auditLogger) {
    try {
        auditLogger.info('Populating user-role mappings');
        
        await tx.run(DELETE.from('UserRoleMappings').where({ auditRunID_ID: auditRunID }));
        
        await tx.run(`
            INSERT INTO sap_sf_audit_UserRoleMappings 
            (ID, auditRunID_ID, userId, userName, roleId, roleName, assignedViaGroup)
            SELECT 
                ? AS ID,
                ? AS auditRunID_ID,
                gm.userId,
                gm.userName,
                rtp.roleId,
                rtp.roleName,
                gm.groupName
            FROM sap_sf_audit_GroupMembers gm
            JOIN sap_sf_audit_RoleTargetPopulations rtp 
                ON rtp.groupId = gm.groupID AND rtp.auditRunID_ID = ?
            WHERE gm.auditRunID_ID = ?
        `, [uuidv4(), auditRunID, auditRunID, auditRunID]);
        
        auditLogger.info('User-role mappings populated');
    } catch (error) {
        auditLogger.error({ error: error.message }, 'Failed to populate user-role mappings');
    }
}
    // Generate executive summary
    async function _generateExecutiveSummary(tx, auditRunID, auditLogger) {
        try {
            auditLogger.info('Generating executive summary');

            await tx.run(DELETE.from('ExecutiveSummary').where({ auditRunID_ID: auditRunID }));

            const metrics = await tx.run(`
                SELECT 
                    (SELECT COUNT(*) FROM sap_sf_audit_Groups WHERE auditRunID_ID = ? AND groupType = 'STATIC') as totalStaticGroups,
                    (SELECT COUNT(*) FROM sap_sf_audit_Groups WHERE auditRunID_ID = ? AND groupType = 'DYNAMIC') as totalDynamicGroups,
                    (SELECT COUNT(*) FROM sap_sf_audit_Groups WHERE auditRunID_ID = ?) as totalGroups,
                    (SELECT COUNT(DISTINCT userId) FROM sap_sf_audit_GroupMembers WHERE auditRunID_ID = ?) as totalUniqueUsers,
                    (SELECT COUNT(*) FROM sap_sf_audit_UserRoleMappings WHERE auditRunID_ID = ?) as totalRoleAssignments,
                    (SELECT COUNT(*) FROM sap_sf_audit_MultiGroupUsers WHERE auditRunID_ID = ? AND riskLevel = 'High') as highAccessUsersCount,
                    (SELECT COUNT(*) FROM sap_sf_audit_Groups WHERE auditRunID_ID = ? AND totalMemberCount >= 51) as largeGroupsCount,
                    (SELECT COUNT(*) FROM sap_sf_audit_UnusedRoles WHERE auditRunID_ID = ?) as unusedRolesCount
                FROM DUMMY
            `, [auditRunID, auditRunID, auditRunID, auditRunID, auditRunID, auditRunID, auditRunID, auditRunID]);

            const auditRunResult = await tx.run(
                SELECT.one.from('AuditRuns').where({ ID: auditRunID })
            );

            const m = metrics[0];

            await tx.run(`
                INSERT INTO sap_sf_audit_ExecutiveSummary (
                    ID, auditRunID_ID, totalStaticGroups, totalDynamicGroups, totalGroups,
                    totalUniqueUsers, usersHighAccess, groupsLargeMembership,
                    highAccessUsersCount, largeGroupsCount,
                    instanceLabel, generationTimestamp, extractionMode
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                uuidv4(),
                auditRunID,
                Number(m.TOTALSTATICGROUPS) || 0,
                Number(m.TOTALDYNAMICGROUPS) || 0,
                Number(m.TOTALGROUPS) || 0,
                Number(m.TOTALUNIQUEUSERS) || 0,
                Number(m.HIGHACCESSUSERSCOUNT) || 0,
                Number(m.LARGEGROUPSCOUNT) || 0,
                Number(m.HIGHACCESSUSERSCOUNT) || 0,
                Number(m.LARGEGROUPSCOUNT) || 0,
                auditRunResult.INSTANCE || 'QAS',
                new Date(),
                auditRunResult.MODE || 'FULL'
            ]);

            auditLogger.info('Executive summary generated successfully');

        } catch (error) {
            auditLogger.error({ error: error.message }, 'Failed to generate executive summary');
        }
    }

    //identify users with 5+ groups
    async function _populateMultiGroupUsers(tx, auditRunID, auditLogger) {
    try {
        auditLogger.info('Populating multi-group users risk analysis');
        
        await tx.run(DELETE.from('MultiGroupUsers').where({ auditRunID_ID: auditRunID }));
        
        await tx.run(`
            INSERT INTO sap_sf_audit_MultiGroupUsers 
            (ID, auditRunID_ID, userId, userName, groupCount, groupNames, riskLevel, riskScore, riskCategory, recommendedAction)
            SELECT 
                ? AS ID,
                ? AS auditRunID_ID,
                userId,
                MAX(userName) AS userName,
                COUNT(*) AS groupCount,
                STRING_AGG(groupName, ', ') AS groupNames,
                CASE 
                    WHEN COUNT(*) >= 10 THEN 'High'
                    WHEN COUNT(*) >= 5 THEN 'Medium'
                    ELSE 'Low'
                END AS riskLevel,
                COUNT(*) AS riskScore,
                CASE 
                    WHEN COUNT(*) >= 10 THEN 'Critical'
                    WHEN COUNT(*) >= 5 THEN 'Elevated'
                    ELSE 'Normal'
                END AS riskCategory,
                CASE 
                    WHEN COUNT(*) >= 10 THEN 'Immediate review required'
                    WHEN COUNT(*) >= 5 THEN 'Review access'
                    ELSE 'Monitor'
                END AS recommendedAction
            FROM sap_sf_audit_GroupMembers
            WHERE auditRunID_ID = ?
            GROUP BY userId
            HAVING COUNT(*) >= 5
        `, [uuidv4(), auditRunID, auditRunID]);
        
        auditLogger.info('Multi-group users populated');
    } catch (error) {
        auditLogger.error({ error: error.message }, 'Failed to populate multi-group users');
    }
}

async function _populateInactiveUserAccess(tx, auditRunID, auditLogger) {
    try {
        auditLogger.info('Populating inactive users with access');
        
        await tx.run(DELETE.from('InactiveUserAccess').where({ auditRunID_ID: auditRunID }));
        
        await tx.run(`
            INSERT INTO sap_sf_audit_InactiveUserAccess 
            (ID, auditRunID_ID, userId, userName, firstName, lastName, status, hireDate, permissionGroups, groupCount, riskScore, riskCategory, recommendedAction)
            SELECT 
                ? AS ID,
                ? AS auditRunID_ID,
                u.userId,
                u.userName,
                u.firstName,
                u.lastName,
                u.status,
                u.hireDate,
                STRING_AGG(gm.groupName, ', ') AS permissionGroups,
                COUNT(DISTINCT gm.groupID) AS groupCount,
                COUNT(DISTINCT gm.groupID) * 10 AS riskScore,
                'High' AS riskCategory,
                'Remove access immediately' AS recommendedAction
            FROM sap_sf_audit_Users u
            JOIN sap_sf_audit_GroupMembers gm ON gm.userId = u.userId AND gm.auditRunID_ID = ?
            WHERE u.status = 'inactive' AND u.auditRunID_ID = ?
            GROUP BY u.userId, u.userName, u.firstName, u.lastName, u.status, u.hireDate
        `, [uuidv4(), auditRunID, auditRunID, auditRunID]);
        
        auditLogger.info('Inactive users with access populated');
    } catch (error) {
        auditLogger.error({ error: error.message }, 'Failed to populate inactive user access');
    }
}

async function _populateGroupSizeDistribution(tx, auditRunID, auditLogger) {
    try {
        auditLogger.info('Populating group size distribution');
        
        await tx.run(DELETE.from('GroupSizeDistribution').where({ auditRunID_ID: auditRunID }));
        
        await tx.run(`
            INSERT INTO sap_sf_audit_GroupSizeDistribution 
            (ID, auditRunID_ID, bucket, groupCount)
            SELECT 
                ? AS ID,
                ? AS auditRunID_ID,
                CASE 
                    WHEN totalMemberCount <= 5 THEN '1–5 members'
                    WHEN totalMemberCount <= 20 THEN '6–20 members'
                    WHEN totalMemberCount <= 50 THEN '21–50 members'
                    WHEN totalMemberCount <= 100 THEN '51–100 members'
                    ELSE '100+ members'
                END AS bucket,
                COUNT(*) AS groupCount
            FROM sap_sf_audit_Groups
            WHERE auditRunID_ID = ?
            GROUP BY bucket
        `, [uuidv4(), auditRunID, auditRunID]);
        
        auditLogger.info('Group size distribution populated');
    } catch (error) {
        auditLogger.error({ error: error.message }, 'Failed to populate group size distribution');
    }
}

async function _populateStaticVsDynamicGroups(tx, auditRunID, auditLogger) {
    try {
        auditLogger.info('Populating static vs dynamic groups comparison');
        
        await tx.run(DELETE.from('StaticVsDynamicGroups').where({ auditRunID_ID: auditRunID }));
        
        await tx.run(`
            INSERT INTO sap_sf_audit_StaticVsDynamicGroups 
            (ID, auditRunID_ID, groupType, averageGroupSize, totalGroups, totalMembers)
            SELECT 
                ? AS ID,
                ? AS auditRunID_ID,
                groupType,
                AVG(totalMemberCount) AS averageGroupSize,
                COUNT(*) AS totalGroups,
                SUM(totalMemberCount) AS totalMembers
            FROM sap_sf_audit_Groups
            WHERE auditRunID_ID = ?
            GROUP BY groupType
        `, [uuidv4(), auditRunID, auditRunID]);
        
        auditLogger.info('Static vs dynamic groups populated');
    } catch (error) {
        auditLogger.error({ error: error.message }, 'Failed to populate static vs dynamic groups');
    }
}

    // ============================
    // ===== SERVICE HANDLERS =====
    // ============================

    // Get Available Instances (Value Help for UI)
    this.on('getAvailableInstances', async (req) => {
        try {
            logger.info('Fetching destinations from destination service');

            const jwt = getJwt(req);
            const destinations = await getAllDestinationsFromDestinationService({ jwt });

            const sfInstances = [];

            for (const dest of destinations) {
                // Check for lowercase 'sfaudit' property
                const hasSFAudit = dest.originalProperties?.sfaudit === true ||
                    dest.originalProperties?.sfaudit === 'true';

                if (hasSFAudit) {
                    sfInstances.push({
                        name: dest.name,
                        url: dest.url
                    });
                    logger.info({ name: dest.name, url: dest.url }, 'Found SF audit instance');
                }
            }

            logger.info({ count: sfInstances.length }, 'Filtered SF instances');
            return sfInstances;

        } catch (error) {
            logger.error({ error: error.message }, 'Failed to get SF instances');
            return [];
        }
    });

    // USER SYNC ACTION
    this.on('syncUsers', async (req) => {
        const { instance } = req.data;
        const syncLogger = logger.child({ operation: 'SYNC_USERS', instance });

        if (!instance) {
            req.error(400, 'Instance parameter is required');
            return { success: false, message: 'Instance parameter is required', stats: null };
        }

        const tx = cds.tx();

        try {
            syncLogger.info('Starting user synchronization');
            await tx.begin();

            // STEP 1: Check if users already exist for this instance
            const existingUserCount = await tx.run(
                SELECT.one.from('Users').where({ instance: instance }).columns('count(*) as count')
            );

            const userCount = Number(existingUserCount[0]?.count || 0);

            // STEP 2: If users exist, return without syncing
            if (userCount > 0) {
                await tx.commit();
                syncLogger.info({ userCount }, 'Users already synced for this instance');

                return {
                    success: true,
                    message: `Users already synced for instance '${instance}'. ${userCount} users exist.`,
                    alreadySynced: true,
                    stats: {
                        existingCount: userCount,
                        inserted: 0,
                        updated: 0,
                        total: userCount,
                        timestamp: new Date().toISOString()
                    }
                };
            }

            // STEP 3: No users exist - fetch and sync
            syncLogger.info('No users found, fetching from SuccessFactors');
            const sfConfig = await _getSFDestination(instance, syncLogger, req);
            const rawUsers = await _fetchAllUsers(sfConfig, syncLogger);
            const users = _formatUsers(rawUsers, instance);
            const stats = await _upsertUsers(tx, users, instance, syncLogger);

            await tx.commit();

            return {
                success: true,
                message: `Users synchronized successfully from ${instance}`,
                alreadySynced: false,
                stats: {
                    inserted: stats.inserted,
                    updated: stats.updated,
                    total: users.length,
                    existingCount: 0,
                    timestamp: new Date().toISOString()
                }
            };

        } catch (error) {
            syncLogger.error({ error: error.message }, 'User sync failed');
            await tx.rollback();
            req.error(500, `User sync failed: ${error.message}`);
            return { success: false, message: error.message, stats: null };
        }
    });

    this.on('syncUsersIncremental', async (req) => {
        const { instance, lastSyncDate } = req.data;
        const syncLogger = logger.child({ operation: 'SYNC_USERS_INCREMENTAL', instance });

        const tx = cds.tx();

        try {
            await tx.begin();

            // Get last sync date from Users table
            const lastSync = await tx.run(
                SELECT.one.from('Users')
                    .where({ instance: instance })
                    .orderBy('lastSyncAt desc')
                    .columns('lastSyncAt')
            );

            const lastSyncTimestamp = lastSync?.lastSyncAt || lastSyncDate || new Date(0);

            syncLogger.info({ lastSyncTimestamp }, 'Fetching users modified after date');

            // Fetch ONLY users modified after last sync
            const sfConfig = await _getSFDestination(instance, syncLogger, req);
            const rawUsers = await _fetchUsersModifiedAfter(sfConfig, lastSyncTimestamp, syncLogger);
            const users = _formatUsers(rawUsers, instance);
            const stats = await _upsertUsers(tx, users, instance, syncLogger);

            await tx.commit();

            return {
                success: true,
                message: `${stats.inserted} new users, ${stats.updated} updated`,
                stats: stats
            };

        } catch (error) {
            await tx.rollback();
            return { success: false, message: error.message };
        }
    });

    // GET USERS ACTION (With Instance Filter)
    this.on('getUsers', async (req) => {
        const { top = 100, skip = 0, status = null, search = null, instance = null } = req.data;

        try {
            const db = await cds.connect.to('db');

            let query = SELECT.from('Users');

            if (instance) {
                query = query.where({ instance: instance });
            }

            if (status) {
                query = query.where({ status: status });
            }

            if (search && search.trim()) {
                const searchTerm = `%${search.trim()}%`;
                query = query.where({
                    or: [
                        { userName: { like: searchTerm } },
                        { firstName: { like: searchTerm } },
                        { lastName: { like: searchTerm } },
                        { email: { like: searchTerm } },
                        { userId: { like: searchTerm } }
                    ]
                });
            }

            const countQuery = query.clone();
            const countResult = await db.run(countQuery.SELECT('count(*) as total'));
            const total = countResult[0]?.total || 0;

            const users = await db.run(
                query
                    .orderBy('userName')
                    .limit(top, skip)
                    .columns([
                        'userId',
                        'userName',
                        'firstName',
                        'lastName',
                        'status',
                        'email',
                        'hireDate',
                        'jobTitle',
                        'department',
                        'lastModifiedDateTime',
                        'instance'
                    ])
            );

            return {
                success: true,
                users: users,
                total: total,
                top: top,
                skip: skip
            };

        } catch (error) {
            logger.error({ error: error.message }, 'Failed to get users');
            req.error(500, `Failed to get users: ${error.message}`);
            return {
                success: false,
                users: [],
                total: 0,
                top: top,
                skip: skip
            };
        }
    });

    // BEFORE CREATE - Audit Runs
    this.before('CREATE', 'AuditRuns', async (req) => {
        const auditLogger = logger.child({ operation: 'CREATE_AUDIT' });

        if (!req.data.name || !req.data.mode || !req.data.instance) {
            auditLogger.error('Missing required fields');
            req.error(400, 'Missing required fields: name, mode, instance');
        }

        if (!['FULL', 'SAMPLE'].includes(req.data.mode)) {
            req.error(400, 'Mode must be FULL or SAMPLE');
        }

        try {
            const destinations = await getAllDestinationsFromDestinationService({ jwt: getJwt(req) });
            const destination = destinations.find(d => d.name === req.data.instance);

            if (!destination) {
                req.error(400, `Instance '${req.data.instance}' not found in destinations`);
            }

            const hasSFAudit = destination.originalProperties?.sfaudit === 'true' ||
                destination.originalProperties?.sfaudit === true;

            if (!hasSFAudit) {
                req.error(400, `Instance '${req.data.instance}' is not configured for SF Audit (missing sfaudit=true)`);
            }

        } catch (error) {
            auditLogger.error({ error: error.message }, 'Failed to validate instance');
            req.error(500, `Failed to validate instance: ${error.message}`);
        }

        req.data.status = 'CREATED';
        req.data.startTime = null;
        req.data.endTime = null;
        req.data.userSyncRequired = true;

        auditLogger.info({
            name: req.data.name,
            mode: req.data.mode,
            instance: req.data.instance
        }, 'Audit run created');
    });

    // AFTER CREATE - Audit Runs
    this.after('CREATE', 'AuditRuns', async (data, req) => {
        setImmediate(() => {
            _runAuditAsync.call(this, data.ID, {
                mode: data.mode,
                extractGroups: data.extractGroups,
                extractRoles: data.extractRoles,
                sampleGroupSize: data.sampleGroupSize,
                sampleMemberSize: data.sampleMemberSize,
                sampleRoleSize: data.sampleRoleSize
            }).catch(err => {
                logger.error({ auditRunID: data.ID, error: err.message }, 'Background audit failed');
            });
        });
    });

    // MAIN BACKGROUND JOB
    // MAIN BACKGROUND JOB (UPDATED with per-instance user sync)
    async function _runAuditAsync(auditRunID, config) {
        const auditLogger = logger.child({ auditRunID, phase: 'AUDIT' });
        const tx = cds.tx();
        var msprocessed;
        let rolesToProcess = [];
        const startTime = Date.now();

        await tx.begin();

        try {
            auditLogger.info({ config }, 'Starting audit execution');

            const auditRun = await tx.run(
                SELECT.one.from('AuditRuns').where({ ID: auditRunID })
            );

            const instance = auditRun.instance;
            auditLogger.info({ instance }, 'Audit run instance');

            await tx.run(
                UPDATE('AuditRuns')
                    .set({
                        status: 'RUNNING',
                        startTime: new Date()
                    })
                    .where({ ID: auditRunID })
            );

            const activeRun = {
                id: auditRunID,
                cancelled: false,
                progress: 0,
                message: 'Starting audit...'
            };

            this.activeRuns.set(auditRunID, activeRun);

            const sfConfig = await _getSFDestination(instance, auditLogger, null);

            // ============================
            // PHASE 1: USER SYNC (PER INSTANCE)
            // ============================
            activeRun.message = 'Checking user sync status for instance...';

            // Check if users already exist for THIS instance
            const existingUserCount = await tx.run(
                SELECT.one.from('Users').where({ instance: instance }).columns('count(*) as count')
            );

            const userCount = Number(existingUserCount[0]?.count || 0);

            if (userCount === 0) {
                // FIRST TIME for this instance - Full sync all users
                auditLogger.info({ instance }, 'No users found for this instance - performing full sync');
                activeRun.message = `Syncing users for ${instance} (first time)...`;

                const users = await _fetchAllUsers(sfConfig, auditLogger);
                const formattedUsers = _formatUsers(users, instance);
                await _upsertUsers(tx, formattedUsers, instance, auditLogger);

                auditLogger.info({ userCount: users.length, instance }, 'Full user sync completed');
                activeRun.progress = 10;

            } else {
                // Users EXIST for this instance - Check for new/modified users
                auditLogger.info({ userCount, instance }, 'Users already exist for this instance - checking for updates');
                activeRun.message = `Checking for new/modified users in ${instance}...`;

                // Get the most recent sync timestamp for this instance
                const lastSyncResult = await tx.run(
                    SELECT.one.from('Users')
                        .where({ instance: instance })
                        .orderBy('lastSyncAt desc')
                        .columns('lastSyncAt')
                );

                const lastSyncDate = lastSyncResult?.lastSyncAt || new Date(0);
                auditLogger.info({ lastSyncDate, instance }, 'Last sync timestamp');

                // Fetch only users modified after last sync
                const modifiedUsers = await _fetchUsersModifiedAfter(sfConfig, lastSyncDate, auditLogger);

                if (modifiedUsers.length > 0) {
                    auditLogger.info({ newCount: modifiedUsers.length, instance }, 'Found new/modified users - upserting');
                    const formattedUsers = _formatUsers(modifiedUsers, instance);
                    const upsertStats = await _upsertUsers(tx, formattedUsers, instance, auditLogger);
                    auditLogger.info({ inserted: upsertStats.inserted, updated: upsertStats.updated }, 'Incremental sync completed');
                } else {
                    auditLogger.info({ instance }, 'No new or modified users found');
                }

                activeRun.progress = 10;
            }

            // ============================
            // PHASE 2: GROUPS
            // ============================
            let groupStats = { static: 0, dynamic: 0 };

            if (config.extractGroups) {
                auditLogger.info('Starting group extraction');
                activeRun.message = 'Extracting groups...';

                const staticGroups = await _fetchGroupsWithPagination(sfConfig, true, auditLogger);
                const dynamicGroups = await _fetchGroupsWithPagination(sfConfig, false, auditLogger);

                groupStats = {
                    static: staticGroups.length,
                    dynamic: dynamicGroups.length,
                    total: staticGroups.length + dynamicGroups.length
                };

                await _saveGroups(tx, auditRunID, staticGroups, 'STATIC', auditLogger);
                await _saveGroups(tx, auditRunID, dynamicGroups, 'DYNAMIC', auditLogger);

                activeRun.progress = 30;

                auditLogger.info('Starting member extraction');
                activeRun.message = 'Extracting group members...';

                const allGroups = [...staticGroups, ...dynamicGroups];
                let groupsToProcess = allGroups;

                if (config.mode === 'SAMPLE' && config.sampleGroupSize > 0) {
                    groupsToProcess = allGroups.slice(0, config.sampleGroupSize);
                    auditLogger.info({ original: allGroups.length, sampled: groupsToProcess.length }, 'Applied group sampling');
                }

                const memberStats = await _fetchAndSaveMembers(
                    tx,
                    auditRunID,
                    groupsToProcess,
                    sfConfig,
                    config,
                    auditLogger
                );

                await _updateGroupStatistics(tx, auditRunID, auditLogger);
                msprocessed = memberStats.membershipsProcessed;
            }

            // ============================
            // PHASE 3: ROLES
            // ============================
            if (config.extractRoles) {
                auditLogger.info('Starting role extraction');
                activeRun.message = 'Extracting roles...';

                const roles = await _fetchRolesWithPagination(sfConfig, auditLogger);

                rolesToProcess = roles;
                if (config.mode === 'SAMPLE' && config.sampleRoleSize > 0) {
                    rolesToProcess = roles.slice(0, config.sampleRoleSize);
                    auditLogger.info({ original: roles.length, sampled: rolesToProcess.length }, 'Applied role sampling');
                }

                await _saveRoles(tx, auditRunID, rolesToProcess, auditLogger);
                activeRun.progress = 80;
            }

            // ============================
            // PHASE 4: ANALYTICS
            // ============================
            auditLogger.info('Generating analytics');
            activeRun.message = 'Generating analytics...';

            await _generateAnalytics(tx, auditRunID, auditLogger);
            await _populateRoleTargetsAndUnusedRoles(tx, auditRunID, sfConfig, auditLogger);
            await _populateUserRoleMappings(tx, auditRunID, auditLogger);      // ← NEW
            await _populateMultiGroupUsers(tx, auditRunID, auditLogger);        // ← NEW
            await _populateInactiveUserAccess(tx, auditRunID, auditLogger);     // ← NEW
            await _populateGroupSizeDistribution(tx, auditRunID, auditLogger);  // ← NEW
            await _populateStaticVsDynamicGroups(tx, auditRunID, auditLogger);  // ← NEW
            await _generateExecutiveSummary(tx, auditRunID, auditLogger);

            // ============================
            // COMPLETE
            // ============================
            const executionTime = Date.now() - startTime;

            await tx.run(
                UPDATE('AuditRuns')
                    .set({
                        status: 'COMPLETED',
                        endTime: new Date(),
                        groupsProcessed: groupStats.total || 0,
                        membershipsProcessed: msprocessed || 0,
                        rolesProcessed: rolesToProcess?.length || 0
                    })
                    .where({ ID: auditRunID })
            );

            await tx.commit();

            auditLogger.info({
                executionTime: `${executionTime}ms`,
                groups: groupStats,
                members: msprocessed
            }, 'Audit completed successfully');

        } catch (error) {
            auditLogger.error({ error: error.message, stack: error.stack }, 'Audit failed');

            try {
                await tx.run(
                    UPDATE('AuditRuns')
                        .set({
                            status: 'FAILED',
                            endTime: new Date(),
                            errorMessage: error.message.substring(0, 2000)
                        })
                        .where({ ID: auditRunID })
                );
                await tx.commit();
            } catch (dbError) {
                auditLogger.error({ error: dbError.message }, 'Failed to update audit status');
            }

        } finally {
            this.activeRuns.delete(auditRunID);
        }
    }

    // GET AUDIT STATUS
    this.on('getAuditStatus', async (req) => {
        const { auditRunID } = req.data;
        const tx = cds.transaction(req);

        try {
            const auditRun = await tx.run(
                SELECT.one.from('AuditRuns').where({ ID: auditRunID })
            );

            if (!auditRun) {
                req.error(404, `Audit run ${auditRunID} not found`);
                return;
            }

            const activeRun = this.activeRuns?.get(auditRunID);
            let progress = activeRun?.progress || 0;
            let currentPhase = activeRun?.message || 'Idle';

            if (auditRun.status === 'RUNNING') {
                if (auditRun.mode === 'SAMPLE') {
                    const targetGroups = auditRun.sampleGroupSize || 5;
                    const targetMembers = auditRun.sampleMemberSize || 10;
                    const targetRoles = auditRun.sampleRoleSize || 3;
                    const totalTarget = targetGroups + targetMembers + targetRoles;
                    const processed = (auditRun.groupsProcessed || 0) + (auditRun.membershipsProcessed || 0) + (auditRun.rolesProcessed || 0);
                    progress = totalTarget > 0 ? Math.min(Math.floor((processed / totalTarget) * 100), 99) : 0;
                } else {
                    progress = activeRun?.progress || 0;
                }
            }

            return {
                status: auditRun.status,
                progress: progress,
                currentPhase: currentPhase,
                message: currentPhase,
                groupCount: auditRun.groupsProcessed || 0,
                userCount: auditRun.membershipsProcessed || 0,
                roleCount: auditRun.rolesProcessed || 0,
                memberCount: 0,
                startTime: auditRun.startTime,
                endTime: auditRun.endTime,
                errorMessage: auditRun.errorMessage
            };

        } catch (error) {
            req.error(500, error.message);
        }
    });

    // LIST AUDIT RUNS (With Instance Filter)
    this.on('listAuditRuns', async (req) => {
        const { status = null, instance = null, top = 50, skip = 0 } = req.data;

        try {
            const db = await cds.connect.to('db');

            let query = SELECT.from('AuditRuns');

            if (status) {
                query = query.where({ status: status });
            }

            if (instance) {
                query = query.where({ instance: instance });
            }

            const runs = await db.run(
                query
                    .orderBy('createdAt desc')
                    .limit(top, skip)
                    .columns(['ID', 'name', 'description', 'status', 'mode', 'instance', 'startTime', 'endTime', 'createdAt'])
            );

            return runs;

        } catch (error) {
            req.error(500, error.message);
            return [];
        }
    });

    //Delete Cascading
    this.on('deleteAuditRun', async (req) => {
    const { auditRunID } = req.data;
    const tx = cds.tx();
    
    try {
        await tx.begin();
        
        // Delete in correct order (child tables first)
        const deleteOrder = [
            'UserRoleMappings',
            'RoleTargetPopulations',
            'GroupMembers',
            'MultiGroupUsers',
            'InactiveUserAccess',
            'GroupSizeDistribution',
            'StaticVsDynamicGroups',
            'UserGroupCountDistribution',
            'UnusedRoles',
            'ExecutiveSummary',
            'Groups',
            'Roles',
            'AuditRuns'
        ];
        
        for (const entity of deleteOrder) {
            await tx.run(DELETE.from(entity).where({ auditRunID_ID: auditRunID }));
        }
        
        await tx.commit();
        
        return { success: true, message: `Audit run ${auditRunID} deleted successfully` };
        
    } catch (error) {
        await tx.rollback();
        req.error(500, `Delete failed: ${error.message}`);
        return { success: false, message: error.message };
    }
});

});