const cds = require('@sap/cds');

module.exports = cds.service.impl(async function () {

    // ============================
    // REGISTER HANDLERS
    // ============================

    this.on('getRiskDashboard', getRiskDashboard);
    this.on('getGroupDetails', getGroupDetails);
    this.on('getUserAccessAnalysis', getUserAccessAnalysis);
    this.on('getExecutiveSummary', getExecutiveSummary);
    this.on('getGroupSizeAnalysis', getGroupSizeAnalysis);
    this.on('getUserDetails', getUserDetails);
    this.on('getHighRiskUsers', getHighRiskUsers);
    this.on('getRoleDetails', getRoleDetails);
    this.on('getRoleCoverageAnalysis', getRoleCoverageAnalysis);
    this.on('getGroupRoleMatrix', getGroupRoleMatrix);
    this.on('getUserRoleMatrix', getUserRoleMatrix);
    this.on('getUsersByRole', getUsersByRole);
    this.on('getRolesByUser', getRolesByUser);
    this.on('exportAuditData', exportAuditData);
    this.on('exportReport', exportReport);

    // ============================
    // RISK DASHBOARD
    // ============================
    async function getRiskDashboard(req) {
        // console.log("req",req);
        const { auditRunID } = req.data;
        const tx = cds.transaction(req);

        try {

            const auditRun = await tx.run(
                SELECT.one.from('AuditRuns').where({ ID: auditRunID })
            );

            if (!auditRun) {
                req.error(404, `Audit run ${auditRunID} not found`);
            }

            const [riskMetrics, totals] = await Promise.all([
                _getRiskMetrics(tx, auditRunID),
                _getTotals(tx, auditRunID)
            ]);

            return {
                auditInfo: {
                    name: auditRun.name,
                    instance: auditRun.instance,
                    status: auditRun.status,
                    mode: auditRun.mode,
                    generatedAt: auditRun.endTime || auditRun.startTime
                },
                riskMetrics,
                totals
            };

        } catch (error) {
            req.error(500, error.message);
        }
    }

    // ============================
    // GROUP DETAILS (OPTIMIZED)
    // ============================
    async function getGroupDetails(req) {

        const { auditRunID, top = 100, skip = 0 } = req.data;
        const tx = cds.transaction(req);

        try {

            const groups = await tx.run(`
                SELECT 
                    g.groupID,
                    g.groupName,
                    g.groupType,
                    g.totalMemberCount,
                    COUNT(DISTINCT gm.user_ID) as actualMemberCount,
                    COUNT(DISTINCT rtp.roleId) as roleTargetCount
                FROM sap_sf_audit_Groups g
                LEFT JOIN sap_sf_audit_GroupMembers gm 
                    ON gm.group_ID = g.ID AND gm.auditRunID_ID = ?
                LEFT JOIN sap_sf_audit_RoleTargetPopulations rtp 
                    ON rtp.groupId = g.groupID AND rtp.auditRunID_ID = ?
                WHERE g.auditRunID_ID = ?
                GROUP BY g.ID
                ORDER BY g.totalMemberCount DESC
                LIMIT ? OFFSET ?
            `, [auditRunID, auditRunID, auditRunID, top, skip]);

            return groups.map(g => ({
                groupID: g.groupID,
                groupName: g.groupName,
                groupType: g.groupType,
                totalMemberCount: Number(g.totalMemberCount || 0),
                actualMemberCount: Number(g.actualMemberCount || 0),
                roleTargetCount: Number(g.roleTargetCount || 0)
            }));

        } catch (error) {
            req.error(500, error.message);
        }
    }

    // ============================
    // USER ACCESS ANALYSIS
    // ============================
    async function getUserAccessAnalysis(req) {

        const { auditRunID, top = 20 } = req.data;
        const tx = cds.transaction(req);

        try {
            // Get users with group counts directly from GroupMembers
            const users = await tx.run(`
                SELECT 
                    gm.userId,
                    u.userName,
                    u.firstName,
                    u.lastName,
                    u.department,
                    u.jobTitle,
                    COUNT(DISTINCT gm.groupID) as groupCount
                FROM sap_sf_audit_GroupMembers gm
                LEFT JOIN sap_sf_audit_Users u 
                    ON u.userId = gm.userId
                WHERE gm.auditRunID_ID = ?
                GROUP BY gm.userId, u.userName, u.firstName, u.lastName, u.department, u.jobTitle
                ORDER BY groupCount DESC
                LIMIT ?
            `, [auditRunID, top]);

            // Get risk levels separately
            const riskUsers = await tx.run(`
                SELECT userId, riskLevel
                FROM sap_sf_audit_MultiGroupUsers
                WHERE auditRunID_ID = ?
            `, [auditRunID]);
            
            const riskMap = new Map();
            for (const ru of riskUsers) {
                riskMap.set(ru.USERID, ru.RISKLEVEL);
            }

            // Calculate access distribution
            const distribution = [
                { groupCountRange: '1 group', userCount: 0, percentage: 0 },
                { groupCountRange: '2 groups', userCount: 0, percentage: 0 },
                { groupCountRange: '3–4 groups', userCount: 0, percentage: 0 },
                { groupCountRange: '5–7 groups', userCount: 0, percentage: 0 },
                { groupCountRange: '8+ groups', userCount: 0, percentage: 0 }
            ];

            for (const user of users) {
                const count = user.GROUPCOUNT || 0;
                if (count === 1) distribution[0].userCount++;
                else if (count === 2) distribution[1].userCount++;
                else if (count <= 4) distribution[2].userCount++;
                else if (count <= 7) distribution[3].userCount++;
                else distribution[4].userCount++;
            }

            const totalUsers = users.length;
            for (let d of distribution) {
                d.percentage = totalUsers > 0 ? (d.userCount / totalUsers) * 100 : 0;
            }

            return {
                topUsersByGroupCount: users.map(u => ({
                    userName: u.USERNAME || u.USERID,
                    firstName: u.FIRSTNAME || '',
                    lastName: u.LASTNAME || '',
                    department: u.DEPARTMENT || '',
                    jobTitle: u.JOBTITLE || '',
                    groupCount: Number(u.GROUPCOUNT || 0),
                    roleCount: 0,
                    riskLevel: riskMap.get(u.USERID) || 'Low'
                })),
                accessDistribution: distribution,
                usersWithExcessiveAccess: users
                    .filter(u => (u.GROUPCOUNT || 0) >= 5)
                    .map(u => ({
                        userName: u.USERNAME || u.USERID,
                        groupCount: u.GROUPCOUNT,
                        roleCount: 0,
                        groups: ''
                    }))
            };

        } catch (error) {
            console.error('getUserAccessAnalysis error:', error);
            req.error(500, error.message);
        }
    }

    // ============================
    // EXECUTIVE SUMMARY
    // ============================
    async function getExecutiveSummary(req) {
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

            const groups = await tx.run(
                SELECT.from('Groups').where({ auditRunID_ID: auditRunID })
            );
            
            const staticGroups = groups.filter(g => g.groupType === 'STATIC').length;
            const dynamicGroups = groups.filter(g => g.groupType === 'DYNAMIC').length;
            
            const members = await tx.run(
                SELECT.from('GroupMembers').where({ auditRunID_ID: auditRunID })
            );
            const uniqueUsers = new Set(members.map(m => m.userId)).size;
            
            const multiGroup = await tx.run(
                SELECT.from('MultiGroupUsers').where({ auditRunID_ID: auditRunID })
            );
            const highRiskCount = multiGroup.filter(u => u.riskLevel === 'High').length;
            
            const largeGroups = groups.filter(g => (g.totalMemberCount || 0) >= 51).length;
            
            const roles = await tx.run(
                SELECT.from('Roles').where({ auditRunID_ID: auditRunID })
            );

            return {
                auditInfo: {
                    name: auditRun.name,
                    instance: auditRun.instance || 'QAS',
                    generatedAt: auditRun.endTime || auditRun.startTime,
                    mode: auditRun.mode,
                    status: auditRun.status
                },
                metrics: {
                    totalGroups: groups.length,
                    staticGroups: staticGroups,
                    dynamicGroups: dynamicGroups,
                    totalUsers: uniqueUsers,
                    highAccessUsers: highRiskCount,
                    largeGroups: largeGroups,
                    totalRoles: roles.length,
                    unusedRoles: 0
                },
                riskIndicators: {
                    highAccessUsersCount: highRiskCount,
                    largeGroupsCount: largeGroups,
                    inactiveUsersWithAccess: 0,
                    unusedRolesCount: 0
                },
                recommendations: highRiskCount > 0 ? [{
                    category: 'Security Risk',
                    priority: 'High',
                    description: `Found ${highRiskCount} users with high-risk access levels`,
                    affectedCount: highRiskCount
                }] : []
            };

        } catch (error) {
            req.error(500, error.message);
        }
    }

    // ============================
    // GROUP SIZE ANALYSIS
    // ============================
    async function getGroupSizeAnalysis(req) {
        const { auditRunID } = req.data;
        const tx = cds.transaction(req);

        try {
            const groups = await tx.run(`
                SELECT 
                    totalMemberCount,
                    groupType
                FROM sap_sf_audit_Groups
                WHERE auditRunID_ID = ?
            `, [auditRunID]);

            const distribution = [
                { sizeRange: '1–5 members', groupCount: 0, percentage: 0 },
                { sizeRange: '6–20 members', groupCount: 0, percentage: 0 },
                { sizeRange: '21–50 members', groupCount: 0, percentage: 0 },
                { sizeRange: '51–100 members', groupCount: 0, percentage: 0 },
                { sizeRange: '100+ members', groupCount: 0, percentage: 0 }
            ];

            let totalMembers = 0;
            let groupSizes = [];

            for (const group of groups) {
                const count = group.TOTALMEMBERCOUNT || 0;
                totalMembers += count;
                groupSizes.push(count);

                if (count <= 5) distribution[0].groupCount++;
                else if (count <= 20) distribution[1].groupCount++;
                else if (count <= 50) distribution[2].groupCount++;
                else if (count <= 100) distribution[3].groupCount++;
                else distribution[4].groupCount++;
            }

            const totalGroups = groups.length;
            for (let d of distribution) {
                d.percentage = totalGroups > 0 ? (d.groupCount / totalGroups) * 100 : 0;
            }

            groupSizes.sort((a, b) => a - b);
            const avg = totalGroups > 0 ? totalMembers / totalGroups : 0;
            const median = groupSizes[Math.floor(groupSizes.length / 2)] || 0;
            const max = groupSizes[groupSizes.length - 1] || 0;
            const min = groupSizes[0] || 0;

            const staticGroups = groups.filter(g => g.GROUPTYPE === 'STATIC');
            const dynamicGroups = groups.filter(g => g.GROUPTYPE === 'DYNAMIC');

            const staticAvg = staticGroups.length > 0 
                ? staticGroups.reduce((sum, g) => sum + (g.TOTALMEMBERCOUNT || 0), 0) / staticGroups.length : 0;
            const dynamicAvg = dynamicGroups.length > 0 
                ? dynamicGroups.reduce((sum, g) => sum + (g.TOTALMEMBERCOUNT || 0), 0) / dynamicGroups.length : 0;

            const oversizedGroups = groups
                .filter(g => (g.TOTALMEMBERCOUNT || 0) >= 51)
                .map(g => ({
                    groupName: g.GROUPNAME,
                    totalMembers: g.TOTALMEMBERCOUNT,
                    activeMembers: g.TOTALMEMBERCOUNT
                }))
                .slice(0, 20);

            return {
                distribution,
                summary: {
                    totalGroups,
                    averageGroupSize: Math.round(avg * 100) / 100,
                    medianGroupSize: median,
                    maxGroupSize: max,
                    minGroupSize: min
                },
                oversizedGroups,
                staticVsDynamic: [
                    {
                        groupType: 'Static',
                        count: staticGroups.length,
                        averageSize: Math.round(staticAvg * 100) / 100,
                        totalMembers: staticGroups.reduce((sum, g) => sum + (g.TOTALMEMBERCOUNT || 0), 0)
                    },
                    {
                        groupType: 'Dynamic',
                        count: dynamicGroups.length,
                        averageSize: Math.round(dynamicAvg * 100) / 100,
                        totalMembers: dynamicGroups.reduce((sum, g) => sum + (g.TOTALMEMBERCOUNT || 0), 0)
                    }
                ]
            };

        } catch (error) {
            req.error(500, error.message);
        }
    }

    // ============================
    // USER DETAILS
    // ============================
    async function getUserDetails(req) {
        const { auditRunID, status = null, minGroupCount = 0, top = 100, skip = 0 } = req.data;
        const tx = cds.transaction(req);

        try {
            // Step 1: Get all users from central Users table (no auditRunID filter)
            let userQuery = `
                SELECT 
                    userId, userName, firstName, lastName, status, email,
                    department, division, location, jobTitle
                FROM sap_sf_audit_Users
                WHERE 1=1
            `;
            let params = [];
            
            if (status) {
                userQuery += ` AND status = ?`;
                params.push(status);
            }
            
            userQuery += ` ORDER BY userName LIMIT ? OFFSET ?`;
            params.push(top, skip);
            
            const users = await tx.run(userQuery, params);
            
            if (users.length === 0) {
                return [];
            }
            
            // Step 2: Get group counts for these users from GroupMembers
            const userIds = users.map(u => `'${u.USERID}'`).join(',');
            
            const groupCounts = await tx.run(`
                SELECT 
                    userId,
                    COUNT(DISTINCT groupID) as groupCount
                FROM sap_sf_audit_GroupMembers
                WHERE auditRunID_ID = ? AND userId IN (${userIds})
                GROUP BY userId
            `, [auditRunID]);
            
            const groupCountMap = new Map();
            for (const gc of groupCounts) {
                groupCountMap.set(gc.USERID, Number(gc.GROUPCOUNT));
            }
            
            // Step 3: Get group names for these users
            const groupNames = await tx.run(`
                SELECT 
                    userId,
                    groupName
                FROM sap_sf_audit_GroupMembers
                WHERE auditRunID_ID = ? AND userId IN (${userIds})
                ORDER BY userId, groupName
            `, [auditRunID]);
            
            const groupNamesMap = new Map();
            for (const gn of groupNames) {
                const userId = gn.USERID;
                const groupName = gn.GROUPNAME;
                if (!groupNamesMap.has(userId)) {
                    groupNamesMap.set(userId, []);
                }
                groupNamesMap.get(userId).push(groupName);
            }
            
            // Step 4: Get risk levels
            const riskUsers = await tx.run(`
                SELECT userId, riskLevel
                FROM sap_sf_audit_MultiGroupUsers
                WHERE auditRunID_ID = ? AND userId IN (${userIds})
            `, [auditRunID]);
            
            const riskMap = new Map();
            for (const ru of riskUsers) {
                riskMap.set(ru.USERID, ru.RISKLEVEL);
            }
            
            // Step 5: Build results
            const results = [];
            for (const user of users) {
                const groupCount = groupCountMap.get(user.USERID) || 0;
                
                if (minGroupCount > 0 && groupCount < minGroupCount) {
                    continue;
                }
                
                const groupNamesList = groupNamesMap.get(user.USERID) || [];
                
                results.push({
                    userId: user.USERID,
                    userName: user.USERNAME,
                    firstName: user.FIRSTNAME,
                    lastName: user.LASTNAME,
                    status: user.STATUS,
                    email: user.EMAIL,
                    department: user.DEPARTMENT,
                    division: user.DIVISION,
                    location: user.LOCATION,
                    jobTitle: user.JOBTITLE,
                    groupCount: groupCount,
                    roleCount: 0,
                    groupNames: groupNamesList.join(', '),
                    riskLevel: riskMap.get(user.USERID) || 'Low'
                });
            }

            return results;

        } catch (error) {
            console.error('getUserDetails error:', error);
            req.error(500, error.message);
        }
    }

    // ============================
    // HIGH RISK USERS
    // ============================
    async function getHighRiskUsers(req) {
        const { auditRunID, top = 100, skip = 0 } = req.data;
        const tx = cds.transaction(req);

        try {
            const users = await tx.run(`
                SELECT 
                    userId,
                    userName,
                    groupCount,
                    groupNames,
                    riskLevel
                FROM sap_sf_audit_MultiGroupUsers
                WHERE auditRunID_ID = ? AND riskLevel = 'High'
                ORDER BY groupCount DESC
                LIMIT ? OFFSET ?
            `, [auditRunID, top, skip]);

            return users.map(u => ({
                userName: u.USERNAME,
                firstName: '',
                lastName: '',
                department: '',
                jobTitle: '',
                userStatus: 'active',
                groupCount: Number(u.GROUPCOUNT || 0),
                groupNames: u.GROUPNAMES || '',
                riskLevel: u.RISKLEVEL,
                riskScore: Number(u.GROUPCOUNT || 0),
                riskCategory: 'High Risk',
                recommendedAction: 'Review access immediately',
                isInactive: false
            }));

        } catch (error) {
            req.error(500, error.message);
        }
    }

    // ============================
    // ROLE DETAILS
    // ============================
    async function getRoleDetails(req) {
        const { auditRunID, top = 100, skip = 0 } = req.data;
        const tx = cds.transaction(req);

        try {
            const roles = await tx.run(`
                SELECT 
                    r.roleId,
                    r.roleName,
                    r.roleDesc,
                    r.roleType,
                    r.userType,
                    r.lastModifiedBy,
                    r.lastModifiedDate,
                    COUNT(DISTINCT tp.groupId) as targetPopulationCount
                FROM sap_sf_audit_Roles r
                LEFT JOIN sap_sf_audit_RoleTargetPopulations tp 
                    ON tp.roleId = r.roleId AND tp.auditRunID_ID = ?
                WHERE r.auditRunID_ID = ?
                GROUP BY r.roleId, r.roleName, r.roleDesc, r.roleType, r.userType, r.lastModifiedBy, r.lastModifiedDate
                ORDER BY r.roleName
                LIMIT ? OFFSET ?
            `, [auditRunID, auditRunID, top, skip]);

            return roles.map(r => ({
                roleId: r.ROLEID,
                roleName: r.ROLENAME,
                roleDesc: r.ROLEDESC || '',
                roleType: r.ROLETYPE || '',
                userType: r.USERTYPE || '',
                lastModifiedBy: r.LASTMODIFIEDBY || '',
                lastModifiedDate: r.LASTMODIFIEDDATE,
                targetPopulationCount: Number(r.TARGETPOPULATIONCOUNT || 0),
                assignedUserCount: 0,
                usageStatus: (r.TARGETPOPULATIONCOUNT || 0) > 0 ? 'Active' : 'Unused'
            }));

        } catch (error) {
            console.error('getRoleDetails error:', error);
            req.error(500, error.message);
        }
    }

    // ============================
    // ROLE COVERAGE ANALYSIS
    // ============================
    async function getRoleCoverageAnalysis(req) {
        const { auditRunID } = req.data;
        const tx = cds.transaction(req);

        try {
            const roles = await tx.run(`
                SELECT 
                    r.roleId,
                    r.roleName,
                    r.roleType,
                    COUNT(DISTINCT tp.groupId) as targetCount
                FROM sap_sf_audit_Roles r
                LEFT JOIN sap_sf_audit_RoleTargetPopulations tp 
                    ON tp.roleId = r.roleId AND tp.auditRunID_ID = ?
                WHERE r.auditRunID_ID = ?
                GROUP BY r.roleId, r.roleName, r.roleType
            `, [auditRunID, auditRunID]);

            const totalRoles = roles.length;
            const rolesWithTargets = roles.filter(r => r.TARGETCOUNT > 0).length;
            const unusedRoles = roles.filter(r => r.TARGETCOUNT === 0).length;
            const rolesWithMultipleTargets = roles.filter(r => r.TARGETCOUNT > 1).length;

            const rolesByType = {};
            for (const role of roles) {
                const type = role.ROLETYPE || 'unknown';
                if (!rolesByType[type]) {
                    rolesByType[type] = { count: 0, usedCount: 0, unusedCount: 0, totalAssignments: 0 };
                }
                rolesByType[type].count++;
                if (role.TARGETCOUNT > 0) rolesByType[type].usedCount++;
                else rolesByType[type].unusedCount++;
                rolesByType[type].totalAssignments += role.TARGETCOUNT;
            }

            const rolesByTypeArray = Object.entries(rolesByType).map(([roleType, data]) => ({
                roleType,
                count: data.count,
                usedCount: data.usedCount,
                unusedCount: data.unusedCount,
                totalAssignments: data.totalAssignments
            }));

            const topRoles = [...roles]
                .sort((a, b) => b.TARGETCOUNT - a.TARGETCOUNT)
                .slice(0, 10)
                .map(r => ({
                    roleName: r.ROLENAME,
                    assignedUserCount: 0,
                    targetGroupCount: r.TARGETCOUNT
                }));

            const unusedRolesList = roles
                .filter(r => r.TARGETCOUNT === 0)
                .map(r => ({
                    roleId: r.ROLEID,
                    roleName: r.ROLENAME,
                    lastModifiedDate: null
                }));

            return {
                summary: {
                    totalRoles: totalRoles,
                    rolesWithTargets: rolesWithTargets,
                    unusedRoles: unusedRoles,
                    rolesWithMultipleTargets: rolesWithMultipleTargets,
                    averageTargetsPerRole: totalRoles > 0 ? Math.round((rolesWithTargets / totalRoles) * 100) / 100 : 0,
                    averageAssignmentsPerRole: 0
                },
                rolesByType: rolesByTypeArray,
                topRolesByAssignments: topRoles,
                unusedRolesList: unusedRolesList
            };

        } catch (error) {
            console.error('getRoleCoverageAnalysis error:', error);
            req.error(500, error.message);
        }
    }

    // ============================
    // GROUP ROLE MATRIX
    // ============================
    async function getGroupRoleMatrix(req) {
        const { auditRunID, top = 100, skip = 0 } = req.data;
        const tx = cds.transaction(req);

        try {
            const matrix = await tx.run(`
                SELECT 
                    groupId,
                    groupName,
                    roleId,
                    roleName,
                    ruleId,
                    ruleMyFilter,
                    source
                FROM sap_sf_audit_RoleTargetPopulations
                WHERE auditRunID_ID = ?
                ORDER BY groupName, roleName
                LIMIT ? OFFSET ?
            `, [auditRunID, top, skip]);

            return matrix.map(m => ({
                groupId: m.GROUPID,
                groupName: m.GROUPNAME,
                roleId: m.ROLEID,
                roleName: m.ROLENAME,
                ruleId: m.RULEID,
                ruleMyFilter: m.RULEMYFILTER,
                source: m.SOURCE
            }));

        } catch (error) {
            console.error('getGroupRoleMatrix error:', error);
            req.error(500, error.message);
        }
    }

    // ============================
    // USER ROLE MATRIX
    // ============================
    async function getUserRoleMatrix(req) {
        const { auditRunID, userName = null, roleName = null, department = null, top = 100, skip = 0 } = req.data;
        const tx = cds.transaction(req);

        try {
            let query = `
                SELECT 
                    urm.userName,
                    urm.roleName,
                    urm.assignedViaGroup,
                    u.firstName,
                    u.lastName,
                    u.status as userStatus,
                    u.department,
                    u.jobTitle
                FROM sap_sf_audit_UserRoleMappings urm
                LEFT JOIN sap_sf_audit_Users u 
                    ON u.userId = urm.userId
                WHERE urm.auditRunID_ID = ?
            `;
            let params = [auditRunID];
            
            if (userName) {
                query += ` AND urm.userName LIKE ?`;
                params.push(`%${userName}%`);
            }
            if (roleName) {
                query += ` AND urm.roleName LIKE ?`;
                params.push(`%${roleName}%`);
            }
            if (department) {
                query += ` AND u.department LIKE ?`;
                params.push(`%${department}%`);
            }
            
            query += ` ORDER BY urm.userName LIMIT ? OFFSET ?`;
            params.push(top, skip);
            
            const mappings = await tx.run(query, params);

            return mappings.map(m => ({
                userName: m.USERNAME,
                firstName: m.FIRSTNAME || '',
                lastName: m.LASTNAME || '',
                userStatus: m.USERSTATUS || 'active',
                department: m.DEPARTMENT || '',
                jobTitle: m.JOBTITLE || '',
                roleName: m.ROLENAME,
                roleType: '',
                assignedViaGroup: m.ASSIGNEDVIAGROUP
            }));

        } catch (error) {
            console.error('getUserRoleMatrix error:', error);
            req.error(500, error.message);
        }
    }

    // ============================
    // USERS BY ROLE
    // ============================
    async function getUsersByRole(req) {
        const { auditRunID, roleId, top = 100, skip = 0 } = req.data;
        const tx = cds.transaction(req);

        try {
            const users = await tx.run(`
                SELECT 
                    urm.userName,
                    urm.assignedViaGroup,
                    u.firstName,
                    u.lastName,
                    u.department,
                    u.jobTitle,
                    u.status as userStatus
                FROM sap_sf_audit_UserRoleMappings urm
                LEFT JOIN sap_sf_audit_Users u 
                    ON u.userId = urm.userId
                WHERE urm.auditRunID_ID = ? AND urm.roleId = ?
                ORDER BY urm.userName
                LIMIT ? OFFSET ?
            `, [auditRunID, roleId, top, skip]);

            return users.map(u => ({
                userName: u.USERNAME,
                firstName: u.FIRSTNAME || '',
                lastName: u.LASTNAME || '',
                department: u.DEPARTMENT || '',
                jobTitle: u.JOBTITLE || '',
                userStatus: u.USERSTATUS || 'active',
                assignedViaGroup: u.ASSIGNEDVIAGROUP
            }));

        } catch (error) {
            console.error('getUsersByRole error:', error);
            req.error(500, error.message);
        }
    }

    // ============================
    // ROLES BY USER
    // ============================
    async function getRolesByUser(req) {
        const { auditRunID, userName, top = 100, skip = 0 } = req.data;
        const tx = cds.transaction(req);

        try {
            const roles = await tx.run(`
                SELECT 
                    urm.roleId,
                    urm.roleName,
                    urm.assignedViaGroup
                FROM sap_sf_audit_UserRoleMappings urm
                WHERE urm.auditRunID_ID = ? AND urm.userName = ?
                ORDER BY urm.roleName
                LIMIT ? OFFSET ?
            `, [auditRunID, userName, top, skip]);

            return roles.map(r => ({
                roleId: r.ROLEID,
                roleName: r.ROLENAME,
                roleType: '',
                assignedViaGroup: r.ASSIGNEDVIAGROUP
            }));

        } catch (error) {
            console.error('getRolesByUser error:', error);
            req.error(500, error.message);
        }
    }

    // ============================
    // EXPORT FUNCTIONS
    // ============================
    async function exportAuditData(req) {
        return Buffer.from(JSON.stringify({ message: 'Export not implemented yet' }));
    }

    async function exportReport(req) {
        return Buffer.from(JSON.stringify({ message: 'Export not implemented yet' }));
    }

    // ============================
    // HELPERS
    // ============================

    async function _getRiskMetrics(tx, auditRunID) {

        const [result] = await tx.run(`
            SELECT 
                COUNT(CASE WHEN riskLevel = 'High' THEN 1 END) as highRisk,
                COUNT(CASE WHEN riskLevel = 'Medium' THEN 1 END) as mediumRisk,
                COUNT(CASE WHEN riskLevel = 'Low' THEN 1 END) as lowRisk
            FROM sap_sf_audit_MultiGroupUsers
            WHERE auditRunID_ID = ?
        `, [auditRunID]);

        return {
            highRiskUsers: Number(result.highRisk || 0),
            mediumRiskUsers: Number(result.mediumRisk || 0),
            lowRiskUsers: Number(result.lowRisk || 0),
            inactiveUsersWithAccess: 0,
            unusedRolesCount: 0,
            largeGroupsCount: 0
        };
    }

    async function _getTotals(tx, auditRunID) {
        const [groups, users, roles] = await Promise.all([
            tx.run(SELECT.from('Groups').where({ auditRunID_ID: auditRunID }).columns('count(*) as count')),
            tx.run(SELECT.from('Users').where({ auditRunID_ID: auditRunID }).columns('count(*) as count')),
            tx.run(SELECT.from('Roles').where({ auditRunID_ID: auditRunID }).columns('count(*) as count'))
        ]);

        return {
            totalGroups: Number(groups[0]?.count || 0),
            totalUsers: Number(users[0]?.count || 0),
            totalRoles: Number(roles[0]?.count || 0),
            totalGroupMembers: 0,
            totalRoleAssignments: 0
        };
    }

});