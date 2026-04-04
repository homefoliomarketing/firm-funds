'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import SessionTimeout from '@/components/SessionTimeout'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [userRole, setUserRole] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | undefined>(undefined)

  useEffect(() => {
    async function loadRole() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        setUserId(user.id)
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('role')
          .eq('id', user.id)
          .single()
        if (profile) setUserRole(profile.role)
      }
    }
    loadRole()
  }, [])

  return (
    <>
      {userRole && <SessionTimeout userRole={userRole} userId={userId} />}
      {children}
    </>
  )
}
