CREATE TABLE "UserIpAddress" (
    "userId" TEXT NOT NULL,
    "ipAddress" INET NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserIpAddress_pkey" PRIMARY KEY ("userId", "ipAddress"),
    CONSTRAINT "UserIpAddress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "UserIpAddress_ipAddress_lastSeenAt_idx" ON "UserIpAddress"("ipAddress", "lastSeenAt");
