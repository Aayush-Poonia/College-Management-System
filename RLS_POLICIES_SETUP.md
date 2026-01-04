# Row Level Security (RLS) Policies Setup Guide

This document contains the SQL commands needed to set up Row Level Security (RLS) policies for the College Management System to allow students to:
1. Enroll themselves in courses
2. Unenroll from courses
3. Create class sessions when marking attendance

## Prerequisites

- Access to your Supabase SQL Editor
- Admin privileges to modify RLS policies

## Required RLS Policies

### 1. Enrollments Table - Allow Students to Enroll Themselves

**Policy Name:** `Students can enroll themselves`
**Operation:** INSERT
**Policy Definition:**

```sql
CREATE POLICY "Students can enroll themselves"
ON enrollments
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = student_id
  AND EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'student'
  )
);
```

### 2. Enrollments Table - Allow Students to Unenroll Themselves

**Policy Name:** `Students can unenroll themselves`
**Operation:** DELETE
**Policy Definition:**

```sql
CREATE POLICY "Students can unenroll themselves"
ON enrollments
FOR DELETE
TO authenticated
USING (
  auth.uid() = student_id
  AND EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'student'
  )
);
```

### 3. Class Sessions Table - Allow Students to Create Sessions for Enrolled Courses

**Policy Name:** `Students can create sessions for enrolled courses`
**Operation:** INSERT
**Policy Definition:**

```sql
CREATE POLICY "Students can create sessions for enrolled courses"
ON class_sessions
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM enrollments
    WHERE enrollments.course_id = class_sessions.course_id
    AND enrollments.student_id = auth.uid()
  )
  AND EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'student'
  )
);
```

### 4. Attendance Table - Allow Students to Mark Their Own Attendance

**Policy Name:** `Students can mark their own attendance`
**Operation:** INSERT
**Policy Definition:**

```sql
CREATE POLICY "Students can mark their own attendance"
ON attendance
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = student_id
  AND EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'student'
  )
  AND EXISTS (
    SELECT 1 FROM class_sessions
    WHERE class_sessions.id = attendance.session_id
    AND EXISTS (
      SELECT 1 FROM enrollments
      WHERE enrollments.course_id = class_sessions.course_id
      AND enrollments.student_id = auth.uid()
    )
  )
);
```

## Alternative: Simpler Policies (Less Secure)

If the above policies don't work due to table structure differences, you can use these simpler policies:

### Enrollments INSERT (Simple)
```sql
CREATE POLICY "Students can insert their own enrollments"
ON enrollments
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = student_id);
```

### Enrollments DELETE (Simple)
```sql
CREATE POLICY "Students can delete their own enrollments"
ON enrollments
FOR DELETE
TO authenticated
USING (auth.uid() = student_id);
```

### Class Sessions INSERT (Simple)
```sql
CREATE POLICY "Students can create class sessions"
ON class_sessions
FOR INSERT
TO authenticated
WITH CHECK (true);
```

### Attendance INSERT (Simple)
```sql
CREATE POLICY "Students can mark their own attendance"
ON attendance
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = student_id);
```

**Note:** The simple class_sessions policy allows any authenticated user to create sessions. For better security, use the first version that checks enrollment.

## How to Apply These Policies

1. Go to your Supabase Dashboard
2. Navigate to SQL Editor
3. Run each CREATE POLICY command above
4. If policies already exist with the same name, drop them first:

```sql
DROP POLICY IF EXISTS "Students can enroll themselves" ON enrollments;
DROP POLICY IF EXISTS "Students can unenroll themselves" ON enrollments;
DROP POLICY IF EXISTS "Students can create sessions for enrolled courses" ON class_sessions;
DROP POLICY IF EXISTS "Students can mark their own attendance" ON attendance;
```

## Verification

After applying the policies, test:
1. Student enrollment from Course Catalog
2. Student unenrollment from My Courses
3. Student attendance marking

If you encounter issues, check:
- RLS is enabled on the tables: 
  ```sql
  ALTER TABLE enrollments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE class_sessions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
  ```
- The policies are active in the Supabase dashboard
- The user role is correctly set in the profiles table

