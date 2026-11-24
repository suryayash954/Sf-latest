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
});

function getJwt(req) {
    const authHeader = req.headers?.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7);
    }
    if (process.env.NODE_ENV === 'hybrid' || process.env.VCAP_APPLICATION) {
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

    async function _getSFDestination(instanceName, auditLogger, req) {
        const isLocal = !process.env.VCAP_APPLICATION;
        
        if (isLocal) {
            auditLogger.info('LOCAL MODE: Using hardcoded SF configuration');
            return {
                baseURL: 'https://apisalesdemo2.successfactors.eu/odata/v2',
                auth: {
                    username: 'sfadmin@SFCPART002553',
                    password: 'Yash@123'
                },
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                httpsAgent: new https.Agent({ rejectUnauthorized: false }),
                timeout: 120000,
                instanceName: instanceName
            };
        }
        
        try {
            const jwt = req ? getJwt(req) : null;
            const destination = await getDestination({
                destinationName: instanceName,
                jwt: jwt
            });

            if (!destination) {
                throw new Error(`Destination '${instanceName}' not found`);
            }

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
                timeout: 120000,
                instanceName: instanceName
            };

        } catch (error) {
            auditLogger.error({ error: error.message, instance: instanceName }, 'Failed to get SF destination');
            throw error;
        }
    }

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
            
        } catch (error) {
            auditLogger.error({ error: error.message, skip }, 'Failed to fetch users batch');
            throw error;
        }
    }

    auditLogger.info({ totalUsers: users.length }, 'All users fetched');
    return users;
}
 function _formatUsers(rawUsers, instance) {
    const parseSFDate = (dateValue) => {
        if (!dateValue) return null;
        if (typeof dateValue === 'string') {
            const match = dateValue.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);
            if (match) {
                const timestamp = parseInt(match[1]);
                const date = new Date(timestamp);
                return !isNaN(date.getTime()) ? date : null;
            }
            const parsed = new Date(dateValue);
            return !isNaN(parsed.getTime()) ? parsed : null;
        }
        if (dateValue instanceof Date && !isNaN(date.getTime())) {
            return dateValue;
        }
        return null;
    };
    // In _formatUsers, add this debug
    if (rawUsers.length > 0 && rawUsers[0].userId === 'sfadmin') {
        console.log('=== RAW SF USER DATA FOR sfadmin ===');
        console.log('division:', rawUsers[0].division);
        console.log('location:', rawUsers[0].location);
        console.log('company:', rawUsers[0].company);
        console.log('businessSegment:', rawUsers[0].businessSegment);
        console.log('jobCode:', rawUsers[0].jobCode);
        console.log('All keys:', Object.keys(rawUsers[0]));
    }

    return rawUsers.map(user => ({
        userId: user.userId,
        instance: instance,
        userName: user.username || user.userId || '',
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        status: user.status === 't' || user.status === 'T' ? 'inactive' : 'active',
        email: user.email || '',
        hireDate: parseSFDate(user.hireDate),
        terminationDate: parseSFDate(user.companyExitDate),
        lastModifiedDateTime: parseSFDate(user.lastModifiedDateTime) || new Date(),
        timeZone: user.timeZone || '',
        
        // Job & Organization fields - FIX THESE MAPPINGS
        jobTitle: user.title || user.jobTitle || '',
        jobCode: user.jobCode || '',                           // ✅ Add this
        department: user.department || '',
        division: user.division || '',                          // ✅ Add this
        location: user.location || '',                          // ✅ Add this
        company: user.company || '',                            // ✅ Add this
        businessUnit: user.businessSegment || user.businessUnit || '',  // ✅ Add this
        
        // Custom fields
        custom01: user.custom01 || '',
        custom02: user.custom02 || '',
        custom03: user.custom03 || '',
        
        // Sync metadata
        lastSyncAt: new Date(),
        isActive: user.status !== 't' && user.status !== 'T'
    }));
}
// Add this action to force re-sync of specific user
this.on('batchForceSyncUsers', async (req) => {
    const { instance } = req.data;
    const tx = cds.transaction(req);
    
    try {
        // Get all users for this instance
        const users = await tx.run(`
            SELECT userId FROM sap_sf_audit_Users WHERE instance = ?
        `, [instance]);
        
        console.log(`Found ${users.length} users to force sync`);
        
        const sfConfig = await _getSFDestination(instance, logger, req);
        let updated = 0;
        let failed = 0;
        
        // Helper function to safely convert to HANA TIMESTAMP
        const toHanaTimestamp = (dateValue) => {
            if (!dateValue) return null;
            if (dateValue instanceof Date && !isNaN(dateValue.getTime())) {
                return dateValue;
            }
            if (typeof dateValue === 'string') {
                const match = dateValue.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);
                if (match) {
                    const timestamp = parseInt(match[1]);
                    const date = new Date(timestamp);
                    return !isNaN(date.getTime()) ? date : null;
                }
                const parsed = new Date(dateValue);
                return !isNaN(parsed.getTime()) ? parsed : null;
            }
            return null;
        };
        
        for (let i = 0; i < users.length; i++) {
            const user = users[i];
            
            try {
                // Fetch from SF
                const url = `${sfConfig.baseURL}/User?$format=json&$filter=userId eq '${user.USERID}'`;
                const response = await axios.get(url, {
                    auth: sfConfig.auth,
                    headers: sfConfig.headers
                });
                
                const rawUser = response.data?.d?.results?.[0];
                if (rawUser) {
                    const formatted = _formatUsers([rawUser], instance)[0];
                    
                    // Convert date properly
                    const lastModifiedDateTime = toHanaTimestamp(formatted.lastModifiedDateTime);
                    
                    await tx.run(`
                        UPDATE sap_sf_audit_Users 
                        SET jobCode = ?, 
                            division = ?, 
                            location = ?,
                            jobTitle = ?,
                            department = ?,
                            timeZone = ?,
                            lastSyncAt = CURRENT_TIMESTAMP
                        WHERE userId = ? AND instance = ?
                    `, [
                        formatted.jobCode || '',
                        formatted.division || '',
                        formatted.location || '',
                        formatted.jobTitle || '',
                        formatted.department || '',
                        formatted.timeZone || '',
                        user.USERID,
                        instance
                    ]);
                    updated++;
                    
                    if (updated % 100 === 0) {
                        console.log(`Updated ${updated} users...`);
                        await tx.commit();
                        await tx.begin();
                    }
                } else {
                    failed++;
                }
            } catch (error) {
                console.error(`Failed to update ${user.USERID}:`, error.message);
                failed++;
            }
        }
        
        await tx.commit();
        console.log(`Batch complete - Updated: ${updated}, Failed: ${failed}`);
        
        return { success: true, updated, failed, total: users.length };
        
    } catch (error) {
        await tx.rollback();
        return { success: false, error: error.message };
    }
});
this.on('forceSyncUser', async (req) => {
    const { userId, instance } = req.data;
    const tx = cds.transaction(req);
    
    try {
        const sfConfig = await _getSFDestination(instance, logger, req);
        
        // Fetch specific user
        const response = await axios.get(`${sfConfig.baseURL}/User?$format=json&$filter=userId eq '${userId}'`, {
            auth: sfConfig.auth,
            headers: sfConfig.headers
        });
        
        const rawUser = response.data?.d?.results?.[0];
        console.log('Raw user data:', JSON.stringify(rawUser, null, 2));
        
        const formattedUser = _formatUsers([rawUser], instance)[0];
        console.log('Formatted user:', JSON.stringify(formattedUser, null, 2));
        
        // Update in database
        await tx.run(`
            UPDATE sap_sf_audit_Users 
            SET jobCode = ?, division = ?, location = ?, 
                company = ?, businessUnit = ?
            WHERE userId = ? AND instance = ?
        `, [
            formattedUser.jobCode,
            formattedUser.division,
            formattedUser.location,
            formattedUser.company,
            formattedUser.businessUnit,
            userId,
            instance
        ]);
        
        await tx.commit();
        
        return { success: true, rawUser, formattedUser };
    } catch (error) {
        await tx.rollback();
        return { error: error.message };
    }
});

async function _upsertUsers(tx, users, instance, auditLogger) {
    let inserted = 0;
    let updated = 0;

    // Convert any date value to HANA TIMESTAMP format
    const hanaTimestamp = (value) => {
        if (!value) return null;

        let d;

        if (value instanceof Date) {
            d = value;
        } else if (typeof value === 'string') {
            const match = value.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);

            if (match) {
                d = new Date(Number(match[1]));
            } else {
                d = new Date(value);
            }
        } else {
            return null;
        }

        if (isNaN(d.getTime())) {
            return null;
        }

        const pad = (n) => String(n).padStart(2, '0');

        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    for (const user of users) {
        try {

            const hireDate = hanaTimestamp(user.hireDate);

            const terminationDate = hanaTimestamp(
                user.terminationDate
            );

            const lastModifiedDateTime =
                hanaTimestamp(user.lastModifiedDateTime) ||
                hanaTimestamp(new Date());

            await tx.run(`
                INSERT INTO "SAP_SF_AUDIT_USERS"
                (
                    "USERID",
                    "INSTANCE",
                    "USERNAME",
                    "FIRSTNAME",
                    "LASTNAME",
                    "STATUS",
                    "EMAIL",
                    "HIREDATE",
                    "TERMINATIONDATE",
                    "LASTMODIFIEDDATETIME",
                    "JOBTITLE",
                    "JOBCODE",
                    "DEPARTMENT",
                    "DIVISION",
                    "LOCATION",
                    "COMPANY",
                    "BUSINESSUNIT",
                    "TIMEZONE",
                    "CUSTOM01",
                    "CUSTOM02",
                    "CUSTOM03",
                    "LASTSYNCAT",
                    "ISACTIVE"
                )
                VALUES
                (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    CURRENT_TIMESTAMP,
                    ?
                )
            `, [
                user.userId,
                instance,
                user.userName || '',
                user.firstName || '',
                user.lastName || '',
                user.status || 'active',
                user.email || '',
                hireDate,
                terminationDate,
                lastModifiedDateTime,
                user.jobTitle || '',
                user.jobCode || '',
                user.department || '',
                user.division || '',
                user.location || '',
                user.company || '',
                user.businessUnit || '',
                user.timeZone || '',
                user.custom01 || '',
                user.custom02 || '',
                user.custom03 || '',
                user.isActive !== false
            ]);

            inserted++;

        } catch (error) {

            auditLogger.error({
                userId: user.userId,
                hireDate: user.hireDate,
                terminationDate: user.terminationDate,
                lastModifiedDateTime: user.lastModifiedDateTime,
                error: error.message
            }, 'Failed to insert user');
        }
    }

    auditLogger.info({
        inserted,
        updated,
        total: users.length
    }, 'User upsert completed');

    return {
        inserted,
        updated
    };
}

    async function _fetchUsersModifiedAfter(sfConfig, lastSyncTimestamp, auditLogger) {
        const users = [];
        let skip = 0;
        const top = 1000;
        let hasMore = true;
        const filterDate = lastSyncTimestamp instanceof Date ? lastSyncTimestamp : new Date(lastSyncTimestamp);
        const filterDateStr = filterDate.toISOString();

        auditLogger.info({ filterDate: filterDateStr, top }, 'Fetching users modified after timestamp');

        while (hasMore) {
            try {
                const url = `${sfConfig.baseURL}/User?$format=json&$top=${top}&$skip=${skip}&$filter=lastModifiedDateTime gt datetime'${filterDateStr}'`;
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
                auditLogger.debug({ fetched: results.length, total: users.length, skip: skip }, 'Users batch fetched');
            } catch (error) {
                auditLogger.error({ error: error.message, skip, filterDate: filterDateStr }, 'Failed to fetch users batch');
                if (skip === 0 && error.response?.status === 400) {
                    auditLogger.warn('Filter failed, falling back to full fetch');
                    return _fetchAllUsers(sfConfig, auditLogger);
                }
                throw error;
            }
        }
        auditLogger.info({ totalUsers: users.length, filterDate: filterDateStr }, 'Modified users fetched');
        return users;
    }

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

    async function _updateGroupStatistics(tx, auditRunID, auditLogger) {
        await tx.run(`
            UPDATE sap_sf_audit_Groups 
            SET activeMembershipCount = (
                SELECT COUNT(*) 
                FROM sap_sf_audit_GroupMembers 
                WHERE sap_sf_audit_GroupMembers.GROUPID = sap_sf_audit_Groups.GROUPID 
                AND sap_sf_audit_GroupMembers.auditRunID_ID = ?
            )
            WHERE auditRunID_ID = ?
        `, [auditRunID, auditRunID]);
    }

async function _fetchRolesWithPagination(sfConfig, auditLogger) {
   const roles = [];
   let skip = 0;
   const top = 100;
   let hasMore = true;
   // ✅ Use RBPRole (confirmed working)
   const entityName = 'RBPRole';
auditLogger.info({ entityName }, 'Fetching roles from SuccessFactors');
   while (hasMore) {
       try {
           const url = `${sfConfig.baseURL}/${entityName}?$format=json&$top=${top}&$skip=${skip}`;
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
auditLogger.info({ fetched: results.length, total: roles.length }, 'Roles batch fetched');
       } catch (error) {
           auditLogger.error({ error: error.message }, 'Failed to fetch roles');
           throw error;
       }
   }
auditLogger.info({ totalRoles: roles.length }, 'All roles fetched');
   return roles;
}
         async function _saveRoles(tx, auditRunID, roles, auditLogger) {
   if (!roles.length) return;
   const parseSFDate = (dateValue) => {
       if (!dateValue) return null;
       if (typeof dateValue === 'string') {
           const match = dateValue.match(/\/Date\((\d+)\)\//);
           if (match) return new Date(parseInt(match[1]));
       }
       return dateValue instanceof Date ? dateValue : null;
   };
   const entries = roles.map(r => ({
       ID: uuidv4(),
       auditRunID_ID: auditRunID,
       roleId: r.roleId || '',                    // ✅ RBPRole uses roleId
       roleName: r.roleName || '',                // ✅ RBPRole uses roleName
       roleDesc: r.roleDesc || '',                // ✅ RBPRole uses roleDesc
       roleType: r.roleType || 'standard',
       userType: r.userType || 'user',            // ✅ RBPRole has userType
       lastModifiedBy: r.lastModifiedBy || '',    // ✅ RBPRole has lastModifiedBy
       lastModifiedDate: parseSFDate(r.lastModifiedDate)  // ✅ RBPRole has lastModifiedDate
   }));
   const batchSize = 500;
   for (let i = 0; i < entries.length; i += batchSize) {
       const batch = entries.slice(i, i + batchSize);
       await tx.run(INSERT.into('Roles').entries(batch));
   }
auditLogger.info({ count: entries.length }, 'Roles saved from RBPRole');
}
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

async function _populateRoleTargetsAndUnusedRoles(tx, auditRunID, sfConfig, auditLogger) {
   try {
auditLogger.info('=== Starting _populateRoleTargetsAndUnusedRoles ===');
       // STEP 1: Delete existing
       await tx.run(DELETE.from('RoleTargetPopulations').where({ auditRunID_ID: auditRunID }));
       await tx.run(DELETE.from('UnusedRoles').where({ auditRunID_ID: auditRunID }));
       console.log('✅ Cleared existing role target data');
       // STEP 2: Fetch RBPRules with expansion
       let skip = 0;
       const top = 50;
       let hasMore = true;
       let totalRules = 0;
       let totalTargetsCreated = 0;
       while (hasMore) {
           try {
               const url = `${sfConfig.baseURL}/RBPRule?$top=${top}&$skip=${skip}&$expand=targetGroups,roles&$format=json`;
               console.log(`📡 Fetching rules: skip=${skip}`);
               const response = await axios.get(url, {
                   auth: sfConfig.auth,
                   headers: sfConfig.headers,
                   httpsAgent: sfConfig.httpsAgent,
                   timeout: 30000
               });
               const rules = response.data?.d?.results || [];
               console.log(`📦 Rules in batch: ${rules.length}`);
               if (rules.length === 0) break;
               for (const rule of rules) {
                   totalRules++;
                   // Handle targetGroups - always an object with results array
                   let targetGroups = [];
                   if (rule.targetGroups && rule.targetGroups.results) {
                       targetGroups = rule.targetGroups.results;
                   }
                   // Handle roles - can be null, single object, or { results: [...] }
                   let roles = [];
                   if (rule.roles === null || rule.roles === undefined) {
                       roles = [];
                   } else if (Array.isArray(rule.roles)) {
                       roles = rule.roles;
                   } else if (rule.roles.results && Array.isArray(rule.roles.results)) {
                       // Multiple roles: { results: [...] }
                       roles = rule.roles.results;
                   } else if (rule.roles.roleId || rule.roles.__metadata) {
                       // Single role object (like rule 122)
                       roles = [rule.roles];
                   }
                   // Debug first rule
                   if (skip === 0 && totalRules === 1) {
                       console.log('=== FIRST RULE STRUCTURE ===');
                       console.log(`Rule ID: ${rule.ruleId}`);
                       console.log(`targetGroups type: ${typeof rule.targetGroups}`);
                       console.log(`targetGroups count: ${targetGroups.length}`);
                       console.log(`roles type: ${typeof rule.roles}`);
                       console.log(`roles count: ${roles.length}`);
                       if (targetGroups.length > 0) {
                           console.log('Sample targetGroup:', JSON.stringify(targetGroups[0], null, 2));
                       }
                       if (roles.length > 0) {
                           console.log('Sample role:', JSON.stringify(roles[0], null, 2));
                       }
                   }
                   // Insert for each target group (even if no roles)
                   for (const group of targetGroups) {
                       if (roles.length > 0) {
                           // Insert a record for each role
                           for (const role of roles) {
                               try {
                                   await tx.run(`
                                       INSERT INTO sap_sf_audit_RoleTargetPopulations (
                                           ID, auditRunID_ID, roleId, roleName,
                                           groupId, groupName, groupType,
                                           activeMembershipCount, totalMemberCount,
                                           source, ruleId, ruleMyFilter, ruleStatus
                                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                   `, [
                                       uuidv4(),
                                       auditRunID,
                                       String(role.roleId || role.id || ''),
                                       role.roleName || role.name || '',
                                       String(group.groupID || group.groupId || group.id || ''),
                                       group.groupName || group.name || '',
                                       group.groupType || '',
                                       parseInt(group.activeMembershipCount) || 0,
                                       parseInt(group.totalMemberCount) || 0,
                                       'RBPRule',
                                       String(rule.ruleId || ''),
                                       rule.myFilter || '',
                                       parseInt(rule.status) || 0
                                   ]);
                                   totalTargetsCreated++;
                               } catch (insertError) {
                                   console.error(`Insert failed for rule ${rule.ruleId}:`, insertError.message);
                               }
                           }
                       } else {
                           // No roles in this rule - still record the target group
                           try {
                               await tx.run(`
                                   INSERT INTO sap_sf_audit_RoleTargetPopulations (
                                       ID, auditRunID_ID, roleId, roleName,
                                       groupId, groupName, groupType,
                                       activeMembershipCount, totalMemberCount,
                                       source, ruleId, ruleMyFilter, ruleStatus
                                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                               `, [
                                   uuidv4(),
                                   auditRunID,
                                   '',  // No role
                                   '',
                                   String(group.groupID || group.groupId || group.id || ''),
                                   group.groupName || group.name || '',
                                   group.groupType || '',
                                   parseInt(group.activeMembershipCount) || 0,
                                   parseInt(group.totalMemberCount) || 0,
                                   'RBPRule',
                                   String(rule.ruleId || ''),
                                   rule.myFilter || '',
                                   parseInt(rule.status) || 0
                               ]);
                               totalTargetsCreated++;
                           } catch (insertError) {
                               console.error(`Insert failed for rule ${rule.ruleId}:`, insertError.message);
                           }
                       }
                   }
               }
               hasMore = rules.length === top;
               skip += top;
           } catch (error) {
               console.error('Batch fetch error:', error.message);
               auditLogger.error({ error: error.message }, 'Failed to fetch RBPRules batch');
               hasMore = false;
           }
       }
       console.log(`\n✅ Total rules processed: ${totalRules}`);
       console.log(`✅ Total role targets created: ${totalTargetsCreated}\n`);
       // STEP 3: Populate UnusedRoles
       const rolesWithTargets = await tx.run(`
           SELECT DISTINCT roleId
           FROM sap_sf_audit_RoleTargetPopulations
           WHERE auditRunID_ID = ? AND roleId != ''
       `, [auditRunID]);
       const usedRoleIds = new Set(rolesWithTargets.map(r => r.ROLEID));
       console.log(`📊 Roles with targets: ${usedRoleIds.size}`);
       const roles = await tx.run(
           SELECT.from('Roles').where({ auditRunID_ID: auditRunID })
       );
       console.log(`📊 Total roles in system: ${roles.length}`);
       let unusedCount = 0;
       for (const role of roles) {
           if (!usedRoleIds.has(role.roleId)) {
               await tx.run(`
                   INSERT INTO sap_sf_audit_UnusedRoles (
                       ID, auditRunID_ID, roleId, roleName, roleType, recommendation
                   ) VALUES (?, ?, ?, ?, ?, ?)
               `, [
                   uuidv4(),
                   auditRunID,
                   role.roleId,
                   role.roleName,
                   role.roleType || 'standard',
                   'Review / Decommission'
               ]);
               unusedCount++;
           }
       }
       console.log(`✅ Unused roles created: ${unusedCount}\n`);
auditLogger.info({
           totalRules,
           totalTargetsCreated,
           unusedCount
       }, 'Role targets and unused roles populated');
   } catch (error) {
       console.error('❌ _populateRoleTargetsAndUnusedRoles FAILED:', error.message);
       auditLogger.error({ error: error.message, stack: error.stack }, 'Failed to populate role targets');
   }
}

  async function _populateUserRoleMappings(tx, auditRunID, auditLogger) {
    try {
        auditLogger.info('Populating user-role mappings');
        
        await tx.run(DELETE.from('UserRoleMappings').where({ auditRunID_ID: auditRunID }));
        
        // Use raw SQL for better compatibility
        await tx.run(`
           INSERT INTO sap_sf_audit_UserRoleMappings
                (
                ID,
                auditRunID_ID,
                userId,
                userName,
                roleId,
                roleName,
                assignedViaGroup
                )
                SELECT
                SYSUUID,
                ?,
                gm.userId,
                gm.userName,
                rtp.roleId,
                rtp.roleName,
                gm.groupName
            FROM sap_sf_audit_GroupMembers gm
            INNER JOIN sap_sf_audit_RoleTargetPopulations rtp 
                ON rtp.groupId = gm.groupID 
            WHERE gm.auditRunID_ID = ? 
                AND rtp.auditRunID_ID = ?
        `, [auditRunID, auditRunID, auditRunID]);
        
        // Check how many were inserted
        const count = await tx.run(`
            SELECT COUNT(*) as cnt 
            FROM sap_sf_audit_UserRoleMappings 
            WHERE auditRunID_ID = ?
        `, [auditRunID]);
        
        auditLogger.info({ insertedCount: count[0]?.CNT }, 'User-role mappings populated');
        
    } catch (error) {
        auditLogger.error({ error: error.message }, 'Failed to populate user-role mappings');
    }
}

    // FIXED: Replaced new Date() with CURRENT_TIMESTAMP
  async function _generateExecutiveSummary(tx, auditRunID, auditLogger) {
    try {
        auditLogger.info('Generating executive summary');
        
        // LOG 1: Check if we have data in tables
        console.log('=== DEBUG: Executive Summary Start ===');
        console.log('AuditRunID:', auditRunID);
        
        // Check Groups count
        const groupCheck = await tx.run(`
            SELECT COUNT(*) as cnt FROM sap_sf_audit_Groups WHERE auditRunID_ID = ?
        `, [auditRunID]);
        console.log('Groups in this audit run:', groupCheck[0]?.CNT);
        
        // Check GroupMembers count
        const memberCheck = await tx.run(`
            SELECT COUNT(DISTINCT userId) as cnt FROM sap_sf_audit_GroupMembers WHERE auditRunID_ID = ?
        `, [auditRunID]);
        console.log('Unique users in memberships:', memberCheck[0]?.CNT);
        
        // LOG 2: Check audit run details
        const auditRunResult = await tx.run(
            SELECT.one.from('AuditRuns').where({ ID: auditRunID })
        );
        console.log('Audit run instance:', auditRunResult?.INSTANCE || auditRunResult?.instance);
        console.log('Audit run mode:', auditRunResult?.MODE || auditRunResult?.mode);
        
        // LOG 3: Test each metric individually
        const staticGroups = await tx.run(`
            SELECT COUNT(*) as cnt FROM sap_sf_audit_Groups 
            WHERE auditRunID_ID = ? AND groupType = 'STATIC'
        `, [auditRunID]);
        console.log('Static groups count:', staticGroups[0]?.CNT);
        
        const dynamicGroups = await tx.run(`
            SELECT COUNT(*) as cnt FROM sap_sf_audit_Groups 
            WHERE auditRunID_ID = ? AND groupType = 'DYNAMIC'
        `, [auditRunID]);
        console.log('Dynamic groups count:', dynamicGroups[0]?.CNT);
        
        // LOG 4: Check if ExecutiveSummary already has data
        const existingCount = await tx.run(`
            SELECT COUNT(*) as cnt FROM sap_sf_audit_ExecutiveSummary WHERE auditRunID_ID = ?
        `, [auditRunID]);
        console.log('Existing records before delete:', existingCount[0]?.CNT);
        
        // Delete existing
        await tx.run(DELETE.from('ExecutiveSummary').where({ auditRunID_ID: auditRunID }));
        
        // LOG 5: Test the INSERT with minimal fields first
        const testId = uuidv4();
        console.log('Testing minimal insert with ID:', testId);
        
        try {
            await tx.run(`
                INSERT INTO sap_sf_audit_ExecutiveSummary 
                (ID, auditRunID_ID, totalGroups, generationTimestamp)
                VALUES (?, ?, 0, CURRENT_TIMESTAMP)
            `, [testId, auditRunID]);
            console.log('✅ Minimal insert SUCCESS');
            
            // Clean up test
            await tx.run(`DELETE FROM sap_sf_audit_ExecutiveSummary WHERE ID = ?`, [testId]);
            console.log('Test record cleaned up');
        } catch (insertError) {
            console.log('❌ Minimal insert FAILED:', insertError.message);
            console.log('Error details:', insertError);
            throw insertError;
        }
        
        // LOG 6: Now try the full query with proper column access
        const metrics = await tx.run(`
            SELECT 
                (SELECT COUNT(*) FROM sap_sf_audit_Groups WHERE auditRunID_ID = ? AND groupType = 'STATIC') as totalStaticGroups,
                (SELECT COUNT(*) FROM sap_sf_audit_Groups WHERE auditRunID_ID = ? AND groupType = 'DYNAMIC') as totalDynamicGroups,
                (SELECT COUNT(*) FROM sap_sf_audit_Groups WHERE auditRunID_ID = ?) as totalGroups,
                (SELECT COUNT(DISTINCT userId) FROM sap_sf_audit_GroupMembers WHERE auditRunID_ID = ?) as totalUniqueUsers,
                (SELECT COUNT(*) FROM sap_sf_audit_MultiGroupUsers WHERE auditRunID_ID = ? AND riskLevel = 'High') as highAccessUsersCount,
                (SELECT COUNT(*) FROM sap_sf_audit_Groups WHERE auditRunID_ID = ? AND totalMemberCount >= 51) as largeGroupsCount
            FROM DUMMY
        `, [auditRunID, auditRunID, auditRunID, auditRunID, auditRunID, auditRunID]);
        
        console.log('Metrics query result:', JSON.stringify(metrics[0], null, 2));
        
        const m = metrics[0];
        console.log('Accessing properties:');
        console.log('  m.TOTALSTATICGROUPS:', m.TOTALSTATICGROUPS);
        console.log('  m.totalStaticGroups:', m.totalStaticGroups);
        
        // LOG 7: Try the actual insert
        console.log('Attempting full insert...');
        await tx.run(`
            INSERT INTO sap_sf_audit_ExecutiveSummary 
            (ID, auditRunID_ID, totalStaticGroups, totalDynamicGroups, totalGroups,
             totalUniqueUsers, usersHighAccess, groupsLargeMembership,
             highAccessUsersCount, largeGroupsCount,
             instanceLabel, generationTimestamp, extractionMode)
            VALUES (SYSUUID, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
        `, [
            auditRunID,
            Number(m.TOTALSTATICGROUPS) || 0,
            Number(m.TOTALDYNAMICGROUPS) || 0,
            Number(m.TOTALGROUPS) || 0,
            Number(m.TOTALUNIQUEUSERS) || 0,
            Number(m.HIGHACCESSUSERSCOUNT) || 0,
            Number(m.LARGEGROUPSCOUNT) || 0,
            Number(m.HIGHACCESSUSERSCOUNT) || 0,
            Number(m.LARGEGROUPSCOUNT) || 0,
            auditRunResult?.INSTANCE || auditRunResult?.instance || 'Unknown',
            auditRunResult?.MODE || auditRunResult?.mode || 'FULL'
        ]);
        console.log('✅ Insert completed successfully');
        
        // LOG 8: Verify the insert
        const verify = await tx.run(`
            SELECT COUNT(*) as cnt FROM sap_sf_audit_ExecutiveSummary WHERE auditRunID_ID = ?
        `, [auditRunID]);
        console.log('Records after insert:', verify[0]?.CNT);
        
        const result = await tx.run(`SELECT COUNT(*) as cnt FROM sap_sf_audit_ExecutiveSummary WHERE auditRunID_ID = ?`, [auditRunID]);
        auditLogger.info({ insertedCount: result[0]?.CNT }, 'Executive summary populated');
        
    } catch (error) {
        console.log('❌ ERROR in _generateExecutiveSummary:', error.message);
        console.log('Full error:', error);
        auditLogger.error({ error: error.message, stack: error.stack }, 'Failed to generate executive summary');
        throw error;
    }
}

    async function _populateMultiGroupUsers(tx, auditRunID, auditLogger) {
        try {
            auditLogger.info('Populating multi-group users risk analysis');
            await tx.run(DELETE.from('MultiGroupUsers').where({ auditRunID_ID: auditRunID }));
            await tx.run(`
                INSERT INTO sap_sf_audit_MultiGroupUsers 
                (ID, auditRunID_ID, userId, userName, groupCount, groupNames, riskLevel, riskScore, riskCategory, recommendedAction)
                SELECT 
                    SYSUUID AS ID,
                    ? AS auditRunID_ID,
                    userId,
                    MAX(userName) AS userName,
                    COUNT(*) AS groupCount,
                    STRING_AGG(groupName, ', ') AS groupNames,
                    CASE 
                        WHEN COUNT(*) >= 5 THEN 'High'
                        WHEN COUNT(*) >= 2 THEN 'Medium'
                        ELSE 'Low'
                    END AS riskLevel,
                    COUNT(*) AS riskScore,
                    CASE 
                        WHEN COUNT(*) >= 5 THEN 'Critical'
                        WHEN COUNT(*) >= 2 THEN 'Elevated'
                        ELSE 'Normal'
                    END AS riskCategory,
                    CASE 
                        WHEN COUNT(*) >= 5 THEN 'Immediate review required'
                        WHEN COUNT(*) >= 2 THEN 'Review access'
                        ELSE 'Monitor'
                    END AS recommendedAction
                FROM sap_sf_audit_GroupMembers
                WHERE auditRunID_ID = ?
                GROUP BY userId
                HAVING COUNT(*) >= 2
            `, [auditRunID, auditRunID]);
            auditLogger.info('Multi-group users populated');
        } catch (error) {
            auditLogger.error({ error: error.message }, 'Failed to populate multi-group users');
        }
    }

  async function _populateInactiveUserAccess(tx, auditRunID, auditLogger) {
    try {
        auditLogger.info('Populating inactive users with access');
        
        await tx.run(DELETE.from('InactiveUserAccess').where({ auditRunID_ID: auditRunID }));
        
        // Fix: Remove u.auditRunID_ID (Users table doesn't have this column)
        await tx.run(`
            INSERT INTO sap_sf_audit_InactiveUserAccess 
            (ID, auditRunID_ID, userId, userName, firstName, lastName, status, hireDate, permissionGroups, groupCount, riskScore, riskCategory, recommendedAction)
            SELECT
                SYSUUID,
                ?,
                u.userId,
                u.userName,
                u.firstName,
                u.lastName,
                u.status,
                u.hireDate,
                STRING_AGG(gm.groupName, ', '),
                COUNT(DISTINCT gm.groupID),
                COUNT(DISTINCT gm.groupID) * 10,
                'High',
                'Remove access immediately'
            FROM sap_sf_audit_Users u
            INNER JOIN sap_sf_audit_GroupMembers gm ON gm.userId = u.userId
            WHERE u.status = 'inactive' 
                AND gm.auditRunID_ID = ?
            GROUP BY u.userId, u.userName, u.firstName, u.lastName, u.status, u.hireDate
        `, [auditRunID, auditRunID]);
        
        const result = await tx.run(`SELECT COUNT(*) as cnt FROM sap_sf_audit_InactiveUserAccess WHERE auditRunID_ID = ?`, [auditRunID]);
        auditLogger.info({ insertedCount: result[0]?.CNT }, 'Inactive users with access populated');
        
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
                    SYSUUID,
                    ?,
                    CASE 
                        WHEN totalMemberCount <= 5 THEN '1–5 members'
                        WHEN totalMemberCount <= 20 THEN '6–20 members'
                        WHEN totalMemberCount <= 50 THEN '21–50 members'
                        WHEN totalMemberCount <= 100 THEN '51–100 members'
                        ELSE '100+ members'
                    END,
                    COUNT(*)
                FROM sap_sf_audit_Groups
                WHERE auditRunID_ID = ?
                GROUP BY 
                    CASE 
                        WHEN totalMemberCount <= 5 THEN '1–5 members'
                        WHEN totalMemberCount <= 20 THEN '6–20 members'
                        WHEN totalMemberCount <= 50 THEN '21–50 members'
                        WHEN totalMemberCount <= 100 THEN '51–100 members'
                        ELSE '100+ members'
                    END
            `, [auditRunID, auditRunID]);
            const result = await tx.run(`SELECT COUNT(*) as cnt FROM sap_sf_audit_GroupSizeDistribution WHERE auditRunID_ID = ?`, [auditRunID]);
            auditLogger.info({ insertedCount: result[0]?.CNT }, 'Group size distribution populated');
        } catch (error) {
            auditLogger.error({ error: error.message, stack: error.stack }, 'Failed to populate group size distribution');
            throw error;
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
                    SYSUUID AS ID,
                    ? AS auditRunID_ID,
                    groupType,
                    AVG(totalMemberCount) AS averageGroupSize,
                    COUNT(*) AS totalGroups,
                    SUM(totalMemberCount) AS totalMembers
                FROM sap_sf_audit_Groups
                WHERE auditRunID_ID = ?
                GROUP BY groupType
            `, [auditRunID, auditRunID]);
            auditLogger.info('Static vs dynamic groups populated');
        } catch (error) {
            auditLogger.error({ error: error.message }, 'Failed to populate static vs dynamic groups');
        }
    }

    // ============================
    // ===== SERVICE HANDLERS =====
    // ============================

    this.on('debugConnection', async (req) => {
        console.log('=== DEBUG: debugConnection called ===');
        const { instance } = req.data;
        try {
            console.log('Instance:', instance);
            const sfConfig = await _getSFDestination(instance, logger, req);
            console.log('Destination resolved:', sfConfig.baseURL);
            const testUrl = `${sfConfig.baseURL}/User?$format=json&$top=1`;
            const testResponse = await axios.get(testUrl, {
                auth: sfConfig.auth,
                headers: sfConfig.headers,
                httpsAgent: sfConfig.httpsAgent,
                timeout: 30000
            });
            console.log('API response status:', testResponse.status);
            const countUrl = `${sfConfig.baseURL}/User?$format=json&$top=1&$inlinecount=allpages`;
            const countResponse = await axios.get(countUrl, {
                auth: sfConfig.auth,
                headers: sfConfig.headers,
                httpsAgent: sfConfig.httpsAgent,
                timeout: 30000
            });
            const totalUsers = countResponse.data?.d?.__count || 'Unknown';
            const tx = cds.transaction(req);
            const dbUserCount = await tx.run(
                SELECT.one.from('Users').where({ instance: instance }).columns('count(*) as count')
            );
            const existingDbUsers = Number(dbUserCount[0]?.count || 0);
            return {
                success: true,
                sfUrl: sfConfig.baseURL,
                sfTotalUsers: totalUsers,
                dbExistingUsers: existingDbUsers,
                apiWorking: true
            };
        } catch (error) {
            console.error('Debug error:', error.message);
            return { success: false, error: error.message };
        }
    });

    this.on('getAvailableInstances', async (req) => {
        const isLocal = !process.env.VCAP_APPLICATION;
        if (isLocal) {
            logger.info('LOCAL MODE: Returning hardcoded instance');
            return [{ name: 'successfactors', url: 'https://api68sales.successfactors.com/odata/v2' }];
        }
        try {
            logger.info('CLOUD MODE: Fetching destinations from destination service');
            const jwt = getJwt(req);
            const destinations = await getAllDestinationsFromDestinationService({ jwt });
            const sfInstances = [];
            for (const dest of destinations) {
                const hasSFAudit = dest.originalProperties?.sfaudit === 'true' || dest.originalProperties?.sfaudit === true;
                if (hasSFAudit) {
                    sfInstances.push({ name: dest.name, url: dest.url });
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

 this.on('syncUsers', async (req) => {
    const { instance } = req.data;
    const syncLogger = logger.child({ operation: 'SYNC_USERS', instance });
    
    if (!instance) {
        req.error(400, 'Instance parameter is required');
        return { success: false, message: 'Instance parameter is required', stats: null };
    }
    
    const tx = cds.transaction(req);
    
    try {
        // Check if users already exist for this instance
       const existingUserCount = await tx.run(`
            SELECT COUNT(*) AS CNT
            FROM SAP_SF_AUDIT_USERS
            WHERE INSTANCE = ?
            `, [instance]);

        const userCount = Number(existingUserCount[0]?.CNT || 0);

        console.log('Existing users:', userCount);
        
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
        
        syncLogger.info('No users found, fetching from SuccessFactors');
        
        const sfConfig = await _getSFDestination(instance, syncLogger, req);
        const rawUsers = await _fetchAllUsers(sfConfig, syncLogger);
        const users = _formatUsers(rawUsers, instance);
        
        const stats = await _upsertUsers(tx, users, instance, syncLogger);
        
        await tx.commit();
        
        syncLogger.info({ inserted: stats.inserted, updated: stats.updated }, 'User sync completed');
        
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
        const tx = cds.transaction(req);
        try {
            const lastSync = await tx.run(
                SELECT.one.from('Users')
                    .where({ instance: instance })
                    .orderBy('lastSyncAt desc')
                    .columns('lastSyncAt')
            );
            let lastSyncTimestamp = lastSync?.lastSyncAt ? new Date(lastSync.lastSyncAt) : null;
            if (!lastSyncTimestamp) {
                if (lastSyncDate) {
                    lastSyncTimestamp = new Date(lastSyncDate);
                } else {
                    lastSyncTimestamp = new Date(0);
                }
            }
            if (isNaN(lastSyncTimestamp.getTime())) {
                throw new Error('Invalid date format for lastSyncDate');
            }
            syncLogger.info({ lastSyncTimestamp: lastSyncTimestamp.toISOString() }, 'Fetching users modified after date');
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
            syncLogger.error({ error: error.message }, 'Incremental sync failed');
            await tx.rollback();
            return { success: false, message: error.message };
        }
    });

    

    this.on('getUsers', async (req) => {
        const { top = 100, skip = 0, status = null, search = null, instance = null } = req.data;
        try {
            const db = await cds.connect.to('db');
            let query = SELECT.from('Users');
            if (instance) { query = query.where({ instance: instance }); }
            if (status) { query = query.where({ status: status }); }
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
            const countResult = await db.run(`SELECT COUNT(*) as total FROM sap_sf_audit_Users`);
            const total = countResult[0]?.total || 0;
            const users = await db.run(
                query
                    .orderBy('userName')
                    .limit(top, skip)
                    .columns([
                        'userId', 'userName', 'firstName', 'lastName', 'status', 'email',
                        'hireDate', 'jobTitle', 'department', 'lastModifiedDateTime', 'instance'
                    ])
            );
            return { success: true, users: users, total: total, top: top, skip: skip };
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to get users');
            req.error(500, `Failed to get users: ${error.message}`);
            return { success: false, users: [], total: 0, top: top, skip: skip };
        }
    });

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
            const hasSFAudit = destination.originalProperties?.sfaudit === 'true' || destination.originalProperties?.sfaudit === true;
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
        auditLogger.info({ name: req.data.name, mode: req.data.mode, instance: req.data.instance }, 'Audit run created');
    });

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

    // FIXED: Replaced new Date() with CURRENT_TIMESTAMP and raw SQL for updates
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

            // FIXED: Use raw SQL with CURRENT_TIMESTAMP
            await tx.run(`
                UPDATE sap_sf_audit_AuditRuns 
                SET status = 'RUNNING', 
                    startTime = CURRENT_TIMESTAMP 
                WHERE ID = ?
            `, [auditRunID]);

            const activeRun = {
                id: auditRunID,
                cancelled: false,
                progress: 0,
                message: 'Starting audit...'
            };
            this.activeRuns.set(auditRunID, activeRun);

            const sfConfig = await _getSFDestination(instance, auditLogger, null);

            // PHASE 1: USER SYNC
            activeRun.message = 'Checking user sync status for instance...';
           const existingUserCount = await tx.run(
    SELECT.one.from('Users')
        .where({ instance: instance })
        .columns('count(*) as count')
);

const userCount = Number(existingUserCount[0]?.count || 0);


            if (userCount === 0) {
                auditLogger.info({ instance }, 'No users found for this instance - performing full sync');
                activeRun.message = `Syncing users for ${instance} (first time)...`;
                const users = await _fetchAllUsers(sfConfig, auditLogger);
                const formattedUsers = _formatUsers(users, instance);
                await _upsertUsers(tx, formattedUsers, instance, auditLogger);
                auditLogger.info({ userCount: users.length, instance }, 'Full user sync completed');
                activeRun.progress = 10;
            } else {
                auditLogger.info({ userCount, instance }, 'Users already exist for this instance - checking for updates');
                activeRun.message = `Checking for new/modified users in ${instance}...`;
                const lastSyncResult = await tx.run(
                    SELECT.one.from('Users')
                        .where({ instance: instance })
                        .orderBy('lastSyncAt desc')
                        .columns('lastSyncAt')
                );
                const lastSyncDate = lastSyncResult?.lastSyncAt || new Date(0);
                const modifiedUsers = await _fetchUsersModifiedAfter(sfConfig, lastSyncDate, auditLogger);
                if (modifiedUsers.length > 0) {
                    auditLogger.info({ newCount: modifiedUsers.length, instance }, 'Found new/modified users - upserting');
                    const formattedUsers = _formatUsers(modifiedUsers, instance);
                    const upsertStats = await _upsertUsers(tx, formattedUsers, instance, auditLogger);
                    auditLogger.info({ inserted: upsertStats.inserted, updated: upsertStats.updated }, 'Incremental sync completed');
                }
                activeRun.progress = 10;
            }

            // PHASE 2: GROUPS
            let groupStats = { static: 0, dynamic: 0, total: 0 };
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
                }
                const memberStats = await _fetchAndSaveMembers(tx, auditRunID, groupsToProcess, sfConfig, config, auditLogger);
                await _updateGroupStatistics(tx, auditRunID, auditLogger);
                msprocessed = memberStats.membershipsProcessed;
                activeRun.progress = 60;
            }

            // PHASE 3: ROLES
            if (config.extractRoles) {
                auditLogger.info('Starting role extraction');
                activeRun.message = 'Extracting roles...';
                const roles = await _fetchRolesWithPagination(sfConfig, auditLogger);
                rolesToProcess = roles;
                if (config.mode === 'SAMPLE' && config.sampleRoleSize > 0) {
                    rolesToProcess = roles.slice(0, config.sampleRoleSize);
                }
                await _saveRoles(tx, auditRunID, rolesToProcess, auditLogger);
                activeRun.progress = 80;
            }

            // PHASE 4: ANALYTICS
            auditLogger.info('Generating analytics');
            activeRun.message = 'Generating analytics...';
            await _generateAnalytics(tx, auditRunID, auditLogger);
            await _populateRoleTargetsAndUnusedRoles(tx, auditRunID, sfConfig, auditLogger);
            await _populateUserRoleMappings(tx, auditRunID, auditLogger);
            await _populateMultiGroupUsers(tx, auditRunID, auditLogger);
            await _populateInactiveUserAccess(tx, auditRunID, auditLogger);
            await _populateGroupSizeDistribution(tx, auditRunID, auditLogger);
            await _populateStaticVsDynamicGroups(tx, auditRunID, auditLogger);
            await _generateExecutiveSummary(tx, auditRunID, auditLogger);

            // COMPLETE - FIXED: Use raw SQL with CURRENT_TIMESTAMP
            const executionTime = Date.now() - startTime;
            await tx.run(`
                UPDATE sap_sf_audit_AuditRuns 
                SET status = 'COMPLETED', 
                    endTime = CURRENT_TIMESTAMP,
                    groupsProcessed = ?,
                    membershipsProcessed = ?,
                    rolesProcessed = ?
                WHERE ID = ?
            `, [groupStats.total || 0, msprocessed || 0, rolesToProcess?.length || 0, auditRunID]);

            await tx.commit();
            auditLogger.info({ executionTime: `${executionTime}ms`, groups: groupStats, members: msprocessed }, 'Audit completed successfully');

        } catch (error) {
            auditLogger.error({ error: error.message, stack: error.stack }, 'Audit failed');

            try {
                // FIXED: Use raw SQL with CURRENT_TIMESTAMP
                await tx.run(`
                    UPDATE sap_sf_audit_AuditRuns 
                    SET status = 'FAILED', 
                        endTime = CURRENT_TIMESTAMP,
                        errorMessage = ?
                    WHERE ID = ?
                `, [error.message.substring(0, 2000), auditRunID]);
                await tx.commit();
            } catch (dbError) {
                auditLogger.error({ error: dbError.message }, 'Failed to update audit status');
            }
        } finally {
            this.activeRuns.delete(auditRunID);
        }
    }

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

    this.on('listAuditRuns', async (req) => {
        const { status = null, instance = null, top = 50, skip = 0 } = req.data;
        try {
            const db = await cds.connect.to('db');
            let query = SELECT.from('AuditRuns');
            if (status) { query = query.where({ status: status }); }
            if (instance) { query = query.where({ instance: instance }); }
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

    this.on('deleteAuditRun', async (req) => {
        const { auditRunID } = req.data;
        const tx = cds.transaction(req);
        try {
            console.log('=== DELETE AUDIT RUN ===');
            console.log('auditRunID:', auditRunID);
            const auditRun = await tx.run(
                SELECT.one.from('AuditRuns').where({ ID: auditRunID })
            );
            if (!auditRun) {
                req.error(404, `Audit run ${auditRunID} not found`);
                return { success: false, message: 'Audit run not found' };
            }
            console.log('Found audit run:', auditRun.name);
            await tx.run(`DELETE FROM sap_sf_audit_UserRoleMappings WHERE auditRunID_ID = ?`, [auditRunID]);
            await tx.run(`DELETE FROM sap_sf_audit_RoleTargetPopulations WHERE auditRunID_ID = ?`, [auditRunID]);
            await tx.run(`DELETE FROM sap_sf_audit_GroupMembers WHERE auditRunID_ID = ?`, [auditRunID]);
            await tx.run(`DELETE FROM sap_sf_audit_MultiGroupUsers WHERE auditRunID_ID = ?`, [auditRunID]);
            await tx.run(`DELETE FROM sap_sf_audit_InactiveUserAccess WHERE auditRunID_ID = ?`, [auditRunID]);
            await tx.run(`DELETE FROM sap_sf_audit_GroupSizeDistribution WHERE auditRunID_ID = ?`, [auditRunID]);
            await tx.run(`DELETE FROM sap_sf_audit_StaticVsDynamicGroups WHERE auditRunID_ID = ?`, [auditRunID]);
            await tx.run(`DELETE FROM sap_sf_audit_UserGroupCountDistribution WHERE auditRunID_ID = ?`, [auditRunID]);
            await tx.run(`DELETE FROM sap_sf_audit_UnusedRoles WHERE auditRunID_ID = ?`, [auditRunID]);
            await tx.run(`DELETE FROM sap_sf_audit_ExecutiveSummary WHERE auditRunID_ID = ?`, [auditRunID]);
            await tx.run(`DELETE FROM sap_sf_audit_Groups WHERE auditRunID_ID = ?`, [auditRunID]);
            await tx.run(`DELETE FROM sap_sf_audit_Roles WHERE auditRunID_ID = ?`, [auditRunID]);
            await tx.run(`DELETE FROM sap_sf_audit_AuditRuns WHERE ID = ?`, [auditRunID]);
            await tx.commit();
            console.log('Delete successful');
            return { success: true, message: `Audit run ${auditRunID} deleted successfully` };
        } catch (error) {
            console.error('Delete error:', error.message);
            await tx.rollback();
            req.error(500, `Delete failed: ${error.message}`);
            return { success: false, message: error.message };
        }
    });
});