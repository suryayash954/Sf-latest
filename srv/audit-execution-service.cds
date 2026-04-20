// srv/audit-execution-service.cds
using { sap.sf.audit as db } from '../db/schema';

/**
 * Audit Execution Service
 */
service AuditExecutionService @(path: '/SuccessFactorRBPAudit') {
  
  // Read-only views
  entity AuditRuns as projection on db.AuditRuns excluding { errorMessage };
  entity Users as projection on db.Users;
  entity Groups as projection on db.Groups;
  entity GroupMembers as projection on db.GroupMembers;
  entity Roles as projection on db.Roles;
  
  // ============================================
  // Get Available Instances (Value Help for UI)
  // ============================================
  
  function getAvailableInstances() returns array of {
    name: String(100);
    url: String(500);
  };
  
  // ============================================
  // Actions for User Management
  // ============================================
  
  action syncUsers(
    instance: String(100)
  ) returns {
    success: Boolean;
    message: String(255);
    alreadySynced: Boolean;
    stats: {
      inserted: Integer;
      updated: Integer;
      total: Integer;
      timestamp: Timestamp;
    };
  };

  action syncUsersIncremental(
    instance: String(100),
    lastSyncDate: Timestamp
) returns {
    success: Boolean;
    message: String(255);
    stats: {
        inserted: Integer;
        updated: Integer;
        total: Integer;
        timestamp: Timestamp;
    };
};
  
  action getUsers(
    top: Integer default 100,
    skip: Integer default 0,
    status: String(20),
    search: String(255),
    instance: String(100)
  ) returns {
    success: Boolean;
    data: {
      userId: String(100);
      userName: String(255);
      firstName: String(255);
      lastName: String(255);
      status: String(20);
      email: String(255);
      hireDate: Timestamp;
      jobTitle: String(255);
      department: String(255);
      lastModifiedDateTime: Timestamp;
      instance: String(100);
    };
    pagination: {
      total: Integer;
      top: Integer;
      skip: Integer;
    };
  };
  
  // ============================================
  // Actions for Audit Management
  // ============================================
  
  action getAuditStatus(
    auditRunID: UUID
  ) returns {
    status: String(20);
    progress: Integer;
    currentPhase: String(50);
    message: String(255);
    groupCount: Integer;
    userCount: Integer;
    roleCount: Integer;
    memberCount: Integer;
  };
  
  action deleteAuditRun(
    auditRunID: UUID
  ) returns {
    success: Boolean;
    message: String(255);
  };
  
  function listAuditRuns(
    status: String(20) default null,
    instance: String(100) default null,
    top: Integer default 50,
    skip: Integer default 0
  ) returns array of {
    ID: UUID;
    name: String(255);
    description: String(1000);
    status: String(20);
    mode: String(20);
    instance: String(100);
    startTime: Timestamp;
    endTime: Timestamp;
    createdAt: Timestamp;
    groupCount: Integer;
    userCount: Integer;
    roleCount: Integer;
  };
  
  type AuditRequest: {
    name: String(255);
    description: String(1000);
    mode: String(20);
    instance: String(100);
    extractGroups: Boolean;
    extractRoles: Boolean;
    sampleGroupSize: Integer;
    sampleMemberSize: Integer;
    sampleRoleSize: Integer;
  };
}